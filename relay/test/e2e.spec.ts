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
 * at the relay's root-mounted proxy and loads data through it.
 *
 * There is no browser here: "the UI calls " is verified by
 * asserting that the served /terminal HTML seeds the UI's default-server
 * the root-mounted proxy (the mechanism the official
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
    if (req.method === 'GET' && url.pathname === '/session/ses_e2eAAAAAAAAAAAAAAAAAAA/message') {
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
    .send({ session_id: 'ses_e2eAAAAAAAAAAAAAAAAAAA', directory: '/path', title: 'e2e' })
  expect(created.status).toBe(201)

  bridge = new RelayWSClient(
    relayUrl(),
    new OpencodeClient(`http://127.0.0.1:${opencodePort}`, 'opencode', 'password'),
  )
  await bridge.connect('ses_e2eAAAAAAAAAAAAAAAAAAA', created.body.bridge_token)

  // The join step: a viewer exchanges the access code for a viewer token.
  // Lowercase on purpose — input is normalized like the join page does.
  const activated = await request(relay)
    .post('/api/activate')
    .send({ code: created.body.access_code.toLowerCase(), session_id: 'ses_e2eAAAAAAAAAAAAAAAAAAA' })
  expect(activated.status).toBe(200)
  expect(activated.body.session_id).toBe('ses_e2eAAAAAAAAAAAAAAAAAAA')
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

test('GET /terminal serves the official UI (proxy mounted at the root)', async () => {
  const res = await request(relay).get('/terminal')
  expect(res.status).toBe(200)
  expect(res.headers['content-type']).toContain('text/html')
  // The official UI's SPA mount point.
  expect(res.text).toContain('<div id="root"')
})

test('GET /<session_id> serves the join page unauthenticated, the UI with a viewer cookie', async () => {
  // Unauthenticated: the session-bound join page with the id embedded.
  const unauth = await request(relay).get('/ses_e2eAAAAAAAAAAAAAAAAAAA')
  expect(unauth.status).toBe(200)
  expect(unauth.text).toContain('__OC_SESSION_ID__')
  expect(unauth.text).toContain('ses_e2eAAAAAAAAAAAAAAAAAAA')
  expect(unauth.text).toContain('/api/activate')
  // Authenticated: /<session_id> 302s to the canonical UI session URL.
  const authed = await request(relay).get('/ses_e2eAAAAAAAAAAAAAAAAAAA').set('Cookie', viewerCookie)
  expect(authed.status).toBe(302)
  const uiUrl = authed.headers.location
  expect(uiUrl).toMatch(/^\/[^/]+\/session\/ses_e2eAAAAAAAAAAAAAAAAAAA$/)
  // The canonical URL itself serves the official UI to the authenticated viewer.
  const ui = await request(relay).get(uiUrl).set('Cookie', viewerCookie)
  expect(ui.status).toBe(200)
  expect(ui.text).toContain('<div id="root"')
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

test('the UI loads data through the root proxy with the viewer cookie', async () => {
  for (const [path, expected] of [
    ['/config', { model: 'test' }],
    ['/agent', [{ id: 'build' }]],
    ['/session/ses_e2eAAAAAAAAAAAAAAAAAAA/message', [{ id: 'm1' }]],
  ] as const) {
    const res = await request(relay).get(path).set('Cookie', viewerCookie)
    expect(res.status).toBe(200)
    expect(res.body).toEqual(expected)
  }
})

test('the same UI data requests are rejected without the viewer cookie', async () => {
  for (const path of ['/config', '/session/ses_e2eAAAAAAAAAAAAAAAAAAA/message']) {
    const res = await request(relay).get(path)
    expect(res.status).toBe(401)
  }
})

test('GET /<session_id with underscore> serves the join page / UI (route accepts underscores)', async () => {
  // Session ids contain underscores (ses_sim, ses_browser_e2e). The route
  // must accept them or real sessions 404.
  const created = await request(relay)
    .post('/api/sessions')
    .set('x-api-key', API_KEY)
    .send({ session_id: 'ses_with_underscore', directory: '/path', title: 'u' })
  expect(created.status).toBe(201)
  const res = await request(relay).get('/ses_with_underscore')
  expect(res.status).toBe(200)
})
