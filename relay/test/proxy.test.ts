import { afterAll, beforeAll, expect, test } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import { startServer } from '../src/server'
import { OpencodeClient } from '../../bridge/src/opencode'
import { RelayWSClient } from '../../bridge/src/relay'

/**
 * End-to-end proxy test: viewer HTTP → relay proxy adapter → WS → bridge
 * client → mock opencode, and back. The brief's sketch pointed the mock at
 * the hardcoded localhost:51863; like Task 2 we use an in-process mock on an
 * ephemeral port (51863 is the real, credentialed server on this machine).
 */

let relay: Server
let relayUrl: string
let opencode: Server
let bridge: RelayWSClient
let viewerToken: string
let sess2ViewerToken: string
let lastPromptBody: unknown
let lastPath: string

// The session API requires the shared relay key (read lazily from the env).
const API_KEY = 'test-relay-key'
process.env.RELAY_API_KEY = API_KEY

function json(res: import('node:http').ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

beforeAll(async () => {
  opencode = createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    lastPath = url.pathname
    if (req.method === 'GET' && url.pathname === '/session/sess1/message') {
      return json(res, 200, [{ id: 'm1', limit: url.searchParams.get('limit') }])
    }
    if (req.method === 'GET' && url.pathname === '/session/sess1/todo') {
      return json(res, 200, [{ id: 'todo1' }])
    }
    if (req.method === 'GET' && url.pathname === '/session/status') {
      return json(res, 200, { sess1: 'idle-status', other: 'hidden' })
    }
    if (req.method === 'GET' && url.pathname === '/permission') {
      return json(res, 200, [
        { id: 'perm1', sessionID: 'sess1', permission: 'bash' },
        { id: 'perm-other', sessionID: 'sess-other', permission: 'bash' },
      ])
    }
    if (req.method === 'POST' && /^\/session\/sess1\/permissions\//.test(url.pathname)) {
      return json(res, 200, { ok: true, permissionID: url.pathname.split('/').pop() })
    }
    if (req.method === 'GET' && url.pathname === '/agent') return json(res, 200, [{ id: 'build' }])
    if (req.method === 'GET' && url.pathname === '/config') return json(res, 200, { model: 'test' })
    if (req.method === 'POST' && url.pathname === '/session/sess1/prompt_async') {
      let raw = ''
      req.on('data', (chunk) => (raw += chunk))
      req.on('end', () => {
        lastPromptBody = JSON.parse(raw)
        json(res, 200, { ok: true })
      })
      return
    }
    json(res, 404, { error: 'not found' })
  })
  await new Promise<void>((resolve) => opencode.listen(0, '127.0.0.1', resolve))
  const opencodePort = (opencode.address() as AddressInfo).port

  relay = await startServer(0)
  const relayPort = (relay.address() as AddressInfo).port
  relayUrl = `http://127.0.0.1:${relayPort}`

  const created = await request(relay)
    .post('/api/sessions')
    .set('x-api-key', API_KEY)
    .send({ session_id: 'sess1', directory: '/path', title: 'title' })
  expect(created.status).toBe(201)
  const activated = await request(relay).post('/api/activate').send({ code: created.body.access_code, session_id: 'sess1' })
  expect(activated.status).toBe(200)
  viewerToken = activated.body.viewer_token

  // sess2 gets a viewer token but no bridge connection (for the 502 case).
  const created2 = await request(relay)
    .post('/api/sessions')
    .set('x-api-key', API_KEY)
    .send({ session_id: 'sess2', directory: '/path', title: 'title' })
  const activated2 = await request(relay).post('/api/activate').send({ code: created2.body.access_code, session_id: 'sess2' })
  sess2ViewerToken = activated2.body.viewer_token

  bridge = new RelayWSClient(
    relayUrl,
    new OpencodeClient(`http://127.0.0.1:${opencodePort}`, 'opencode', 'password'),
  )
  await bridge.connect('sess1', created.body.bridge_token)
})

afterAll(async () => {
  bridge.close()
  relay.closeAllConnections()
  await new Promise((resolve) => relay.close(resolve))
  opencode.closeAllConnections()
  await new Promise((resolve) => opencode.close(resolve))
})

test('proxy GET /session/:id/message', async () => {
  const res = await request(relay).get(`/session/sess1/message`).set('x-viewer-token', viewerToken)
  expect(res.status).toBe(200)
  expect(res.body).toEqual([{ id: 'm1', limit: null }])
})

test('proxy forwards the limit query param', async () => {
  const res = await request(relay).get(`/session/sess1/message?limit=5`).set('x-viewer-token', viewerToken)
  expect(res.status).toBe(200)
  expect(res.body).toEqual([{ id: 'm1', limit: '5' }])
})

test('proxy POST prompt_async forwards the JSON body', async () => {
  const res = await request(relay)
    .post('/session/sess1/prompt_async')
    .set('x-viewer-token', viewerToken)
    .send({ parts: [{ type: 'text', text: 'hello' }] })
  expect(res.status).toBe(200)
  expect(lastPromptBody).toEqual({ parts: [{ type: 'text', text: 'hello' }] })
})

test('proxy allowlisted GET endpoints (todo, agent, config)', async () => {
  for (const [path, expected] of [
    ['/session/sess1/todo', [{ id: 'todo1' }]],
    ['/agent', [{ id: 'build' }]],
    ['/config', { model: 'test' }],
  ] as const) {
    const res = await request(relay).get(path).set('x-viewer-token', viewerToken)
    expect(res.status).toBe(200)
    expect(res.body).toEqual(expected)
  }
})

test('proxy GET /session/status is filtered to the viewer session only', async () => {
  const res = await request(relay).get('/session/status').set('x-viewer-token', viewerToken)
  expect(res.status).toBe(200)
  expect(res.body).toEqual({ sess1: 'idle-status' })
})

test('proxy rejects requests without a viewer token', async () => {
  const res = await request(relay).get('/session/sess1/message')
  expect(res.status).toBe(401)
  expect(res.body.error).toBeTruthy()
})

test('proxy rejects an invalid viewer token', async () => {
  const res = await request(relay).get('/session/sess1/message').set('x-viewer-token', 'wrong')
  expect(res.status).toBe(401)
  expect(res.body.error).toBeTruthy()
})

test('proxy forcibly substitutes the session id from the viewer token', async () => {
  const res = await request(relay).get(`/session/evil/message`).set('x-viewer-token', viewerToken)
  expect(res.status).toBe(200)
  // The bridge must have been asked for the viewer's own session, not "evil".
  expect(lastPath).toBe('/session/sess1/message')
})

test('proxy returns 502 when no bridge is connected for the session', async () => {
  const res = await request(relay).get(`/session/sess2/message`).set('x-viewer-token', sess2ViewerToken)
  expect(res.status).toBe(502)
  expect(res.body.error).toBeTruthy()
})

test('bridge WS connection with a bad bridge token is rejected', async () => {
  const bad = new RelayWSClient(
    relayUrl,
    new OpencodeClient('http://127.0.0.1:1', 'opencode', 'password'),
  )
  await expect(bad.connect('sess1', 'wrong-token')).rejects.toThrow()
})


/**
 * Permission replies from the viewer. The relay always appends its own
 * ?directory=… query to the forwarded path, so the bridge-side cross-session
 * guard must match on the pathname only — matching the raw path swallowed the
 * query into the captured permission id and rejected every reply with 403.
 */
test('viewer can answer a permission request of its own session', async () => {
  const res = await request(relay)
    .post('/session/sess1/permissions/perm1')
    .set('x-viewer-token', viewerToken)
    .send({ response: 'once' })
  expect(res.status).toBe(200)
  expect(res.body).toEqual({ ok: true, permissionID: 'perm1' })
})

test('viewer cannot answer a permission request raised by another session', async () => {
  const res = await request(relay)
    .post('/session/sess1/permissions/perm-other')
    .set('x-viewer-token', viewerToken)
    .send({ response: 'once' })
  expect(res.status).toBe(403)
})
