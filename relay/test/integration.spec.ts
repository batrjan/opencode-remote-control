import { afterAll, beforeAll, expect, test } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import WebSocket from 'ws'
import { startServer } from '../src/server'
import { OpencodeClient } from '../../bridge/src/opencode'
import { RelayWSClient } from '../../bridge/src/relay'

/**
 * Full lifecycle integration test against a real relay server, a real bridge
 * WS client (RelayWSClient) and a mock opencode HTTP server:
 *
 *   create session → activate code (viewer cookie) → proxy
 *   GET /session/:id/message and POST /session/:id/prompt_async through the
 *   bridge → opencode SSE events fan out to viewer SSE streams → stop
 *   (DELETE) disconnects the bridge and revokes viewer access.
 *
 * The brief's sketch used a hardcoded opencode at localhost:51863; like the
 * earlier proxy tests we use an in-process mock on an ephemeral port (51863
 * is a real, credentialed server on the dev machine).
 */

// The session API requires the shared relay key; the failed-activation delay
// is a production brute-force brake. Both are read lazily from the env.
const API_KEY = 'test-relay-key'
process.env.RELAY_API_KEY = API_KEY
process.env.ACTIVATE_FAIL_DELAY_MS = '0'

let relay: Server
let relayUrl: string
let opencode: Server
let bridge: RelayWSClient
let viewerToken: string
let viewerCookie: string
let lastPromptBody: unknown
let lastMessagePath: string
let pushOpencodeEvent: (data: string) => void = () => {}

function json(res: import('node:http').ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** Read an SSE stream until `marker` appears or the deadline passes. */
async function readSseUntil(res: globalThis.Response, marker: string, deadlineMs = 4000) {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let received = ''
  const deadline = Date.now() + deadlineMs
  while (!received.includes(marker) && Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    received += decoder.decode(value, { stream: true })
  }
  await reader.cancel()
  return received
}

beforeAll(async () => {
  opencode = createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    if (req.method === 'GET' && url.pathname === '/session/sess1/message') {
      lastMessagePath = url.pathname + url.search
      return json(res, 200, [{ id: 'm1', role: 'user' }])
    }
    if (req.method === 'POST' && url.pathname === '/session/sess1/prompt_async') {
      let raw = ''
      req.on('data', (chunk) => (raw += chunk))
      req.on('end', () => {
        lastPromptBody = JSON.parse(raw)
        json(res, 200, { ok: true })
      })
      return
    }
    if (req.method === 'GET' && url.pathname === '/event') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      res.write(': connected\n\n')
      pushOpencodeEvent = (data) => res.write(`data: ${data}\n\n`)
      req.on('close', () => {
        pushOpencodeEvent = () => {}
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
    .send({ session_id: 'sess1', directory: '/path', title: 'integration' })
  expect(created.status).toBe(201)

  const activated = await request(relay).post('/api/activate').send({ code: created.body.access_code, session_id: 'sess1' })
  expect(activated.status).toBe(200)
  viewerToken = activated.body.viewer_token
  const setCookie = activated.headers['set-cookie'] as unknown as string[]
  viewerCookie = setCookie.find((c) => c.startsWith('viewer_token='))!.split(';')[0]!

  bridge = new RelayWSClient(
    relayUrl,
    new OpencodeClient(`http://127.0.0.1:${opencodePort}`, 'opencode', 'password'),
  )
  await bridge.connect('sess1', created.body.bridge_token)
  await bridge.startEventForwarding()
})

afterAll(async () => {
  bridge.close()
  relay.closeAllConnections()
  await new Promise((resolve) => relay.close(resolve))
  opencode.closeAllConnections()
  await new Promise((resolve) => opencode.close(resolve))
})

test('proxy GET /session/:id/message authenticates with the HttpOnly viewer cookie', async () => {
  const res = await request(relay)
    .get('/session/sess1/message')
    .set('Cookie', viewerCookie)
  expect(res.status).toBe(200)
  expect(res.body).toEqual([{ id: 'm1', role: 'user' }])
  expect(lastMessagePath).toMatch(/^\/session\/sess1\/message\?directory=/)
})

test('proxy GET /session/:id/message also accepts the x-viewer-token header', async () => {
  const res = await request(relay)
    .get('/session/sess1/message')
    .set('x-viewer-token', viewerToken)
  expect(res.status).toBe(200)
  expect(res.body).toEqual([{ id: 'm1', role: 'user' }])
})

test('proxy POST prompt_async delivers the JSON body to opencode', async () => {
  const prompt = { parts: [{ type: 'text', text: 'hello from the viewer' }] }
  const res = await request(relay)
    .post('/session/sess1/prompt_async')
    .set('Cookie', viewerCookie)
    .send(prompt)
  expect(res.status).toBe(200)
  expect(lastPromptBody).toEqual(prompt)
})

test('proxy forcibly binds the session id from the viewer token', async () => {
  const res = await request(relay)
    .get('/session/someone-else/message')
    .set('Cookie', viewerCookie)
  expect(res.status).toBe(200)
  expect(lastMessagePath).toMatch(/^\/session\/sess1\/message\?directory=/)
})

test(
  'viewer SSE stream at /event receives opencode events',
  async () => {
    const res = await fetch(`${relayUrl}/event`, {
      headers: { Cookie: viewerCookie },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    pushOpencodeEvent(JSON.stringify({ type: 'session.updated', n: 1 }))
    const received = await readSseUntil(res, 'session.updated')
    expect(received).toContain(': connected')
    expect(received).toContain('data: {"type":"session.updated","n":1}')
  },
  15_000,
)

test(
  'viewer SSE stream at /global/event (v1 UI SDK path) receives the same fan-out',
  async () => {
    const res = await fetch(`${relayUrl}/global/event`, {
      headers: { Cookie: viewerCookie },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    pushOpencodeEvent(JSON.stringify({ type: 'message.part.updated', n: 2 }))
    const received = await readSseUntil(res, 'message.part.updated')
    expect(received).toContain('data: {"type":"message.part.updated","n":2}')
  },
  15_000,
)

test('DELETE /api/sessions/:id disconnects the session bridge', async () => {
  const created = await request(relay)
    .post('/api/sessions')
    .set('x-api-key', API_KEY)
    .send({ session_id: 'ses_stopAAAAAAAAAAAAAAAAAA', directory: '/p', title: 'stoppable' })
  expect(created.status).toBe(201)
  const wsUrl =
    `${relayUrl.replace(/^http/, 'ws')}/bridge` +
    `?session_id=ses_stopAAAAAAAAAAAAAAAAAA&token=${encodeURIComponent(created.body.bridge_token)}`
  const ws = new WebSocket(wsUrl)
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve())
    ws.on('error', reject)
  })
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)))

  const del = await request(relay).delete('/api/sessions/ses_stopAAAAAAAAAAAAAAAAAA').set('x-api-key', API_KEY)
  expect(del.status).toBe(204)
  expect(await closed).toBe(4001)
})

test('stop: after session delete the viewer cookie no longer authorizes proxying', async () => {
  const del = await request(relay).delete('/api/sessions/sess1').set('x-api-key', API_KEY)
  expect(del.status).toBe(204)
  const res = await request(relay)
    .get('/session/sess1/message')
    .set('Cookie', viewerCookie)
  expect(res.status).toBe(401)
})
