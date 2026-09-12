import { afterEach, expect, test } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/server'
import { Store } from '../src/store'
import { config, trustProxy } from '../src/config'

process.env.ACTIVATE_FAIL_DELAY_MS = '0'

afterEach(() => {
  delete process.env.RELAY_TRUST_PROXY
})

/**
 * Production runs the relay in Docker behind nginx. The proxy reaches the
 * container from the bridge gateway (172.18.0.1), which is NOT loopback — so
 * a hard-coded `trust proxy: 'loopback'` ignored X-Forwarded-For and every
 * client collapsed into that one address. Observed live: every activation
 * logged `ip=::ffff:172.18.0.1`, i.e. one attacker's five wrong codes locked
 * activation for everyone, and the whole service shared one IP's session cap.
 */
test('trustProxy reads the deployment setting, defaulting to loopback', () => {
  expect(trustProxy()).toBe('loopback')
  process.env.RELAY_TRUST_PROXY = 'loopback, uniquelocal'
  expect(trustProxy()).toBe('loopback, uniquelocal')
  process.env.RELAY_TRUST_PROXY = 'false'
  expect(trustProxy()).toBe(false)
  process.env.RELAY_TRUST_PROXY = '1'
  expect(trustProxy()).toBe(1)
  process.env.RELAY_TRUST_PROXY = '  '
  expect(trustProxy()).toBe('loopback')
})

/**
 * Registrations, not activations, are what `req.ip` now governs: the per-address
 * limit on wrong codes is gone (an address is free to change, so it throttled
 * colleagues behind one NAT and not the attacker it was aimed at — the brake is
 * the per-session consecutive-failure lock instead). Registration still keys on
 * the address, so `trust proxy` is still security-relevant and still tested:
 * get it wrong and either every client collapses into the proxy's own address,
 * or a client spoofs its way past the cap with a forged header.
 */
/** Unique across every call, so a repeat run never collides on a session id. */
let probeSeq = 0

async function registrations(app: ReturnType<typeof createApp>, ips: string[]): Promise<number[]> {
  const statuses: number[] = []
  for (const ip of ips) {
    const res = await request(app)
      .post('/api/sessions')
      .set('X-Forwarded-For', ip)
      .send({ session_id: `ses_probe_${probeSeq++}`, directory: '/work', title: 't' })
    statuses.push(res.status)
  }
  return statuses
}

/** One more than an address is allowed to hold active at once. */
const OVER_CAP = config.maxActiveSessionsPerIp + 1

test('per-IP limits key on the client behind a trusted proxy, not on the proxy', async () => {
  // supertest's peer is 127.0.0.1 — a trusted (loopback) proxy — so the
  // forwarded address is the client. Distinct clients never trip each other.
  const app = createApp(new Store())
  const distinct = Array.from({ length: OVER_CAP }, (_, i) => `203.0.113.${i + 1}`)
  expect(await registrations(app, distinct)).toEqual(distinct.map(() => 201))
  // ...while one client past its cap is cut off.
  const same = Array.from({ length: OVER_CAP }, () => '198.51.100.7')
  const statuses = await registrations(app, same)
  expect(statuses.slice(0, config.maxActiveSessionsPerIp)).toEqual(
    Array.from({ length: config.maxActiveSessionsPerIp }, () => 201),
  )
  expect(statuses[config.maxActiveSessionsPerIp]).toBe(429)
})

test('a client-supplied X-Forwarded-For prefix cannot forge a new identity', async () => {
  // nginx APPENDS the real address: "spoofed, real". Express must take the
  // right-most untrusted hop, so different spoofed prefixes from one real
  // client still count against that client.
  const app = createApp(new Store())
  const spoofed = Array.from({ length: OVER_CAP }, (_, i) => `10.0.0.${i + 1}, 198.51.100.9`)
  const statuses = await registrations(app, spoofed)
  expect(statuses[config.maxActiveSessionsPerIp]).toBe(429)
})

test('RELAY_TRUST_PROXY=false ignores the header entirely (direct exposure)', async () => {
  process.env.RELAY_TRUST_PROXY = 'false'
  const app = createApp(new Store())
  const distinct = Array.from({ length: OVER_CAP }, (_, i) => `203.0.113.${i + 1}`)
  const statuses = await registrations(app, distinct)
  // Every request is the same peer now, so the cap trips.
  expect(statuses[config.maxActiveSessionsPerIp]).toBe(429)
})

test('responses carry hardening headers and no server fingerprint', async () => {
  const app = createApp(new Store())
  for (const path of ['/health', '/join', '/api/health']) {
    const res = await request(app).get(path)
    expect(res.status, path).toBe(200)
    expect(res.headers['x-powered-by'], path).toBeUndefined()
    expect(res.headers['x-content-type-options'], path).toBe('nosniff')
    expect(res.headers['x-frame-options'], path).toBe('DENY')
    expect(res.headers['referrer-policy'], path).toBe('no-referrer')
  }
  // Errors too — a 404/401 page is still a page.
  const missing = await request(app).get('/ses_doesnotexist')
  expect(missing.status).toBe(404)
  expect(missing.headers['x-frame-options']).toBe('DENY')
  expect(missing.headers['x-powered-by']).toBeUndefined()
})

test('public registration rejects oversized fields instead of storing them', async () => {
  const app = createApp(new Store())
  const ok = await request(app)
    .post('/api/sessions')
    .send({ session_id: 'ses_sizeok', directory: '/w'.repeat(2000), title: 't'.repeat(1024) })
  expect(ok.status).toBe(201)
  const cases = [
    { session_id: 'ses_' + 'x'.repeat(200), directory: '/w', title: 't' },
    { session_id: 'ses_dir', directory: '/w' + 'x'.repeat(5000), title: 't' },
    { session_id: 'ses_title', directory: '/w', title: 't'.repeat(1025) },
  ]
  for (const body of cases) {
    const res = await request(app).post('/api/sessions').send(body)
    expect(res.status, JSON.stringify(body).slice(0, 40)).toBe(400)
    expect(res.body.error).toBe('field too long')
  }
})

/**
 * Unmatched requests must look like the rest of the API.
 *
 * The proxy allowlist mounts GET /config but not PUT /config, so a PUT fell
 * past every route into express's finalhandler — which answers an HTML page
 * reading "Cannot PUT /config". Wrong content type for a JSON API, and a free
 * statement of which framework is running. Found by probing the live relay.
 */
test('an unmatched method or path answers JSON, not express HTML', async () => {
  const store = new Store()
  const app = createApp(store)
  for (const [method, path] of [
    ['put', '/config'],
    ['patch', '/config'],
    ['delete', '/session/ses_whatever'],
    ['get', '/definitely-not-a-route'],
  ] as const) {
    const res = await (request(app) as unknown as Record<string, (p: string) => request.Test>)[method](path)
    expect(res.status).toBe(404)
    expect(res.headers['content-type']).toContain('application/json')
    expect(res.body).toEqual({ error: 'not found' })
    expect(res.text).not.toContain('Cannot')
  }
})
