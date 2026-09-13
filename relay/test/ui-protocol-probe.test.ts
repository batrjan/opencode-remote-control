import { afterAll, beforeAll, expect, test } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import { startServer } from '../src/server'
import { OpencodeClient } from '../../bridge/src/opencode'
import { RelayWSClient } from '../../bridge/src/relay'

/**
 * The web UI's protocol probe must not wait on the owner's uplink.
 *
 * Every page load starts with detectServerProtocol(): it fetches
 * /global/health with a 5 s abort, and only if that does not answer
 * {healthy:true} falls back to /api/health. Almost the whole bootstrap awaits
 * that promise — global config, providers, path, projects, session status,
 * the transcript and the event stream all start only once it settles. The
 * relay answered /api/health itself but proxied /global/health through the
 * bridge, so every load queued behind a full round trip to the owner's
 * machine: on a slow or busy uplink the transcript appeared a whole RTT
 * later, and with the bridge re-dialling the probe sat out the full 5 s
 * before falling back. The outcome never depended on it: the proxied answer
 * selects v1, and so does the local /api/health fallback, whatever went wrong.
 *
 * /global/health is now answered by the relay, like /api/health.
 */

const API_KEY = 'test-relay-key'
process.env.RELAY_API_KEY = API_KEY
process.env.ACTIVATE_FAIL_DELAY_MS = '0'

const SESSION = 'ses_probeAAAAAAAAAAAAAAAAA'
const IDLE = 'ses_probeidleAAAAAAAAAAAAA'
/** An owner uplink so busy that every answer takes longer than the UI's 5 s probe abort. */
const OPENCODE_DELAY_MS = 6_000

let relay: Server
let opencode: Server
let bridge: RelayWSClient
let viewerCookie: string
let idleCookie: string
/** Every path the bridged OpenCode was asked for. */
const opencodeSeen: string[] = []

beforeAll(async () => {
  opencode = createServer((req, res) => {
    opencodeSeen.push(new URL(req.url ?? '', 'http://localhost').pathname)
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ healthy: true, version: 'test' }))
    }, OPENCODE_DELAY_MS)
  })
  await new Promise<void>((resolve) => opencode.listen(0, '127.0.0.1', resolve))
  const opencodePort = (opencode.address() as AddressInfo).port

  relay = await startServer(0)

  const created = await share(SESSION)
  bridge = new RelayWSClient(
    relayUrl(),
    new OpencodeClient(`http://127.0.0.1:${opencodePort}`, 'opencode', 'password'),
  )
  await bridge.connect(SESSION, created.bridgeToken)
  viewerCookie = created.cookie
  // A second share whose bridge never connects.
  idleCookie = (await share(IDLE)).cookie
}, 15_000)

afterAll(async () => {
  bridge.close()
  relay.closeAllConnections()
  await new Promise((resolve) => relay.close(resolve))
  opencode.closeAllConnections()
  await new Promise((resolve) => opencode.close(resolve))
})

function relayUrl(): string {
  return `http://127.0.0.1:${(relay.address() as AddressInfo).port}`
}

async function share(session_id: string) {
  const created = await request(relay)
    .post('/api/sessions')
    .set('x-api-key', API_KEY)
    .send({ session_id, directory: '/path', title: 'probe' })
  expect(created.status).toBe(201)
  const activated = await request(relay).post('/api/activate').send({ code: created.body.access_code, session_id })
  expect(activated.status).toBe(200)
  const setCookie = activated.headers['set-cookie'] as unknown as string[]
  const cookie = setCookie.find((c) => c.startsWith('viewer_token='))!.split(';')[0]!
  return { bridgeToken: created.body.bridge_token as string, cookie }
}

// ---- Verbatim from the UI: src/utils/server-protocol.ts -------------------
// (authTokenFromCredentials inlined; a viewer's server entry has no password.)
type ServerProtocol = 'v1' | 'v2'
type HttpBase = { url: string; username?: string; password?: string }

function headers(server: HttpBase) {
  if (!server.password) return
  return {
    Authorization: `Basic ${btoa(`${server.username ?? 'opencode'}:${server.password}`)}`,
  }
}

async function probe(server: HttpBase, fetch: typeof globalThis.fetch, path: string) {
  const response = await fetch(new URL(path, server.url), {
    headers: headers(server),
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return
  const value: unknown = await response.json()
  if (!value || typeof value !== 'object') return
  return value
}

async function detectServerProtocol(server: HttpBase, fetch: typeof globalThis.fetch): Promise<ServerProtocol> {
  const legacy = await probe(server, fetch, '/global/health').catch(() => undefined)
  if (legacy && 'healthy' in legacy && legacy.healthy === true) return 'v1'

  const current = await probe(server, fetch, '/api/health').catch(() => undefined)
  if (current && 'pid' in current && typeof current.pid === 'number') return 'v2'
  if (current && 'healthy' in current && current.healthy === true) return 'v1'
  return 'v2'
}
// ---------------------------------------------------------------------------

/** The browser's fetch: same-origin, so the viewer cookie rides along. */
function browserFetch(cookie?: string): typeof globalThis.fetch {
  return (input, init) => {
    const h = new Headers(init?.headers)
    if (cookie) h.set('cookie', cookie)
    return fetch(input, { ...init, headers: h })
  }
}

test('GET /global/health answers at once without a trip to the bridge', async () => {
  const started = Date.now()
  const res = await browserFetch(viewerCookie)(`${relayUrl()}/global/health`, { signal: AbortSignal.timeout(2_000) })
  const elapsed = Date.now() - started
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('application/json')
  expect(await res.json()).toEqual({ healthy: true })
  expect(elapsed).toBeLessThan(500)
  // Give a forwarded request time to reach OpenCode before looking.
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(opencodeSeen).not.toContain('/global/health')
})

test("the UI's protocol probe settles on v1 without waiting out a slow bridge", async () => {
  const started = Date.now()
  const protocol = await detectServerProtocol({ url: relayUrl() }, browserFetch(viewerCookie))
  const elapsed = Date.now() - started
  expect(protocol).toBe('v1')
  expect(elapsed).toBeLessThan(1_000)
}, 10_000)

test('GET /global/health answers healthy with no cookie and with no bridge connected', async () => {
  for (const cookie of [undefined, idleCookie]) {
    const res = await browserFetch(cookie)(`${relayUrl()}/global/health`, { signal: AbortSignal.timeout(2_000) })
    expect(res.status, cookie ? 'bridge not connected' : 'no cookie').toBe(200)
    expect(await res.json()).toEqual({ healthy: true })
  }
  expect(await detectServerProtocol({ url: relayUrl() }, browserFetch(idleCookie))).toBe('v1')
})
