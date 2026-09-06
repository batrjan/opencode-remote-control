import { afterAll, beforeAll, expect, test } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import { startServer } from '../src/server'
import { OpencodeClient } from '../../bridge/src/opencode'
import { RelayWSClient } from '../../bridge/src/relay'

/**
 * Viewer-journey E2E at HTTP level: open /join → submit the access code →
 * land on /terminal (the official opencode web UI) → the UI bootstraps itself
 * at the relay's /api/opencode proxy and loads data through it.
 *
 * There is no browser here: "the UI calls /api/opencode" is verified by
 * asserting that the served /terminal HTML seeds the UI's default-server
 * localStorage key with an /api/opencode URL (the mechanism the official
 * build uses to choose its API base), that the protocol probe the UI performs
 * (/api/health) selects that base-URL-prefixed dialect, and that the exact
 * requests the UI issues succeed through the proxy with the viewer cookie.
 */

const API_KEY = 'test-relay-key'
process.env.RELAY_API_KEY = API_KEY
process.env.ACTIVATE_FAIL_DELAY_MS = '0'

let relay: Server
let opencode: Server
let bridge: RelayWSClient
let viewerCookie: string

function json(res: import('node:http').ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

beforeAll(async () => {
  opencode = createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    if (req.method === 'GET' && url.pathname === '/session/sess-e2e/message') {
      return json(res, 200, [{ id: 'm1' }])
    }
    if (req.method === 'GET' && url.pathname === '/agent') return json(res, 200, [{ id: 'build' }])
    if (req.method === 'GET' && url.pathname === '/config') return json(res, 200, { model: 'test' })
    json(res, 404, { error: 'not found' })
  })
  await new Promise<void>((resolve) => opencode.listen(0, '127.0.0.1', resolve))
  const opencodePort = (opencode.address() as AddressInfo).port

  relay = await startServer(0)

  const created = await request(relay)
    .post('/api/sessions')
    .set('x-api-key', API_KEY)
    .send({ session_id: 'sess-e2e', directory: '/path', title: 'e2e' })
  expect(created.status).toBe(201)

  bridge = new RelayWSClient(
    relayUrl(),
    new OpencodeClient(`http://127.0.0.1:${opencodePort}`, 'opencode', 'password'),
  )
  await bridge.connect('sess-e2e', created.body.bridge_token)

  // The join step: a viewer exchanges the access code for a viewer token.
  // Lowercase on purpose — input is normalized like the join page does.
  const activated = await request(relay)
    .post('/api/activate')
    .send({ code: created.body.access_code.toLowerCase(), session_id: 'sess-e2e' })
  expect(activated.status).toBe(200)
  expect(activated.body.session_id).toBe('sess-e2e')
  const setCookie = activated.headers['set-cookie'] as unknown as string[]
  const cookie = setCookie.find((c) => c.startsWith('viewer_token='))!
  expect(cookie).toContain('HttpOnly')
  expect(cookie).toContain('SameSite=Strict')
  viewerCookie = cookie.split(';')[0]!
})

function relayUrl(): string {
  return `http://127.0.0.1:${(relay.address() as AddressInfo).port}`
}

afterAll(async () => {
  bridge.close()
  relay.closeAllConnections()
  await new Promise((resolve) => relay.close(resolve))
  opencode.closeAllConnections()
  await new Promise((resolve) => opencode.close(resolve))
})

test('GET / redirects to the join page', async () => {
  const res = await request(relay).get('/')
  expect(res.status).toBe(302)
  expect(res.headers.location).toBe('/join')
})

test('GET /join serves a code-entry page that posts to /api/activate', async () => {
  const res = await request(relay).get('/join')
  expect(res.status).toBe(200)
  expect(res.headers['content-type']).toContain('text/html')
  expect(res.text).toContain('<input')
  expect(res.text).toContain('/api/activate')
})

test('GET /terminal serves the official UI wired to the /api/opencode proxy', async () => {
  const res = await request(relay).get('/terminal')
  expect(res.status).toBe(200)
  expect(res.headers['content-type']).toContain('text/html')
  // The official UI's SPA mount point.
  expect(res.text).toContain('<div id="root"')
  // The served HTML must seed the UI's default server URL with the relay's
  // proxy prefix — otherwise the UI calls location.origin and every API
  // request misses the proxy (404).
  expect(res.text).toContain('opencode.settings.dat:defaultServerUrl')
  expect(res.text).toContain('/api/opencode')
})

test('GET /<session_id> serves the join page unauthenticated, the UI with a viewer cookie', async () => {
  // Unauthenticated: the session-bound join page with the id embedded.
  const unauth = await request(relay).get('/sess-e2e')
  expect(unauth.status).toBe(200)
  expect(unauth.text).toContain('__OC_SESSION_ID__')
  expect(unauth.text).toContain('sess-e2e')
  expect(unauth.text).toContain('/api/activate')
  // Authenticated: the official UI.
  const authed = await request(relay).get('/sess-e2e').set('Cookie', viewerCookie)
  expect(authed.status).toBe(200)
  expect(authed.text).toContain('<div id="root"')
  expect(authed.text).toContain('/api/opencode')
})

test('GET /<unknown_session_id> is 404', async () => {
  const res = await request(relay).get('/ses_doesnotexist')
  expect(res.status).toBe(404)
})

test('GET /api/health answers healthy so the UI selects the base-URL-prefixed API dialect', async () => {
  const res = await request(relay).get('/api/health')
  expect(res.status).toBe(200)
  expect(res.body).toEqual({ healthy: true })
})

test('the UI loads data through /api/opencode with the viewer cookie', async () => {
  for (const [path, expected] of [
    ['/api/opencode/config', { model: 'test' }],
    ['/api/opencode/agent', [{ id: 'build' }]],
    ['/api/opencode/session/sess-e2e/message', [{ id: 'm1' }]],
  ] as const) {
    const res = await request(relay).get(path).set('Cookie', viewerCookie)
    expect(res.status).toBe(200)
    expect(res.body).toEqual(expected)
  }
})

test('the same UI data requests are rejected without the viewer cookie', async () => {
  for (const path of ['/api/opencode/config', '/api/opencode/session/sess-e2e/message']) {
    const res = await request(relay).get(path)
    expect(res.status).toBe(401)
  }
})
