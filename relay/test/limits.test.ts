import { afterAll, beforeAll, expect, test } from 'vitest'
import http from 'node:http'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import { startServer } from '../src/server'
import { OpencodeClient } from '../../bridge/src/opencode'
import { RelayWSClient } from '../../bridge/src/relay'

/**
 * Request-size limits and fan-out limits on the relay's HTTP surface.
 *
 * One express.json() cannot serve both sides of this app: the unauthenticated
 * public endpoints must buffer almost nothing, while an authenticated viewer
 * legitimately posts a prompt containing a pasted file. These tests pin both
 * halves, plus the per-session SSE stream cap and the de-duplicated allowlist.
 */

let relay: Server
let relayUrl: string
let opencode: Server
let bridge: RelayWSClient
let viewerToken: string

/** Concurrent SSE streams one session may hold (MAX_STREAMS_PER_SESSION). */
const STREAM_CAP = 64

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

beforeAll(async () => {
  opencode = createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    if (req.method === 'POST' && url.pathname === '/session/sess1/message') {
      let raw = ''
      req.on('data', (chunk) => (raw += chunk))
      req.on('end', () => {
        const parsed = JSON.parse(raw) as { parts?: Array<{ text?: string }> }
        json(res, 200, { ok: true, bytes: parsed.parts?.[0]?.text?.length ?? 0 })
      })
      return
    }
    if (req.method === 'GET' && url.pathname === '/agent') return json(res, 200, [{ id: 'build' }])
    if (req.method === 'GET' && url.pathname === '/command') return json(res, 200, [{ id: 'cmd' }])
    if (req.method === 'GET' && url.pathname === '/skill') return json(res, 200, [{ id: 'skill' }])
    json(res, 404, { error: 'not found' })
  })
  await new Promise<void>((resolve) => opencode.listen(0, '127.0.0.1', resolve))
  const opencodePort = (opencode.address() as AddressInfo).port

  relay = await startServer(0)
  relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`

  const created = await request(relay)
    .post('/api/sessions')
    .send({ session_id: 'sess1', directory: '/path', title: 'title' })
  expect(created.status).toBe(201)
  const activated = await request(relay)
    .post('/api/activate')
    .send({ code: created.body.access_code, session_id: 'sess1' })
  expect(activated.status).toBe(200)
  viewerToken = activated.body.viewer_token

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

/**
 * Public registration is unauthenticated, so the body it will buffer must be
 * small. express's 100 KB default let an anonymous caller lodge 100 KB per
 * request (and a 40 KB title only failed later, in the router's own field
 * checks) — the parser must refuse it first, with a body a JSON client can
 * actually read.
 */
test('an oversized POST to the public /api/sessions is rejected with a JSON 413', async () => {
  const res = await request(relay)
    .post('/api/sessions')
    .send({ session_id: 'ses_toobig', directory: '/path', title: 'x'.repeat(40_000) })
  expect(res.status).toBe(413)
  expect(res.headers['content-type']).toContain('application/json')
  expect(res.body).toEqual({ error: 'payload too large' })
})

test('an oversized POST to the public /api/activate is rejected with a JSON 413', async () => {
  const res = await request(relay)
    .post('/api/activate')
    .send({ code: 'A'.repeat(40_000), session_id: 'sess1' })
  expect(res.status).toBe(413)
  expect(res.body).toEqual({ error: 'payload too large' })
})

/**
 * The other half: a viewer pasting code or a file into a prompt produces a
 * body far over 100 KB, and got an HTML 413 mid-conversation. Authenticated
 * proxy POSTs get real headroom.
 */
test('a ~200 KB authenticated proxy POST is forwarded, not rejected', async () => {
  const text = 'x'.repeat(200_000)
  const res = await request(relay)
    .post('/session/sess1/message')
    .set('x-viewer-token', viewerToken)
    .send({ parts: [{ type: 'text', text }] })
  expect(res.status).toBe(200)
  // The whole body reached the mock opencode server intact.
  expect(res.body).toEqual({ ok: true, bytes: text.length })
})

/**
 * The 25 MB headroom is reachable only behind the viewer check: an anonymous
 * caller is refused before the relay buffers the body at all.
 */
test('an unauthenticated large POST on a proxy path is refused, not buffered', async () => {
  const res = await request(relay)
    .post('/session/sess1/message')
    .send({ parts: [{ type: 'text', text: 'x'.repeat(200_000) }] })
  expect(res.status).toBe(401)
  expect(res.body).toEqual({ error: 'invalid viewer token' })
})

/** One SSE connection to the relay; the caller decides when to hang up. */
function openSse(path: string): Promise<{ status: number; req: http.ClientRequest; res: http.IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${relayUrl}${path}`,
      { method: 'GET', headers: { 'x-viewer-token': viewerToken } },
      (res) => resolve({ status: res.statusCode ?? 0, req, res }),
    )
    req.on('error', reject)
    req.end()
  })
}

function readBody(res: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = ''
    res.setEncoding('utf8')
    res.on('data', (chunk) => (raw += chunk))
    res.on('end', () => resolve(raw))
  })
}

/**
 * Each stream costs a bridge subscription and a heartbeat timer and lives
 * until the client hangs up, so an authenticated viewer looping fetch('/event')
 * could pin relay memory and CPU. The cap is per session and shared by both
 * stream routes; a slot must come back when its stream closes.
 */
test('a session cannot hold more than the cap of concurrent SSE streams', async () => {
  const streams: Array<{ req: http.ClientRequest; res: http.IncomingMessage }> = []
  try {
    for (let i = 0; i < STREAM_CAP; i++) {
      const s = await openSse('/event')
      expect(s.status, `stream ${i}`).toBe(200)
      s.res.resume()
      streams.push(s)
    }
    // One over the cap: refused with a readable JSON error, not a stalled
    // stream — and the /global/event route draws on the same budget.
    const over = await openSse('/event')
    expect(over.status).toBe(429)
    expect(JSON.parse(await readBody(over.res))).toEqual({ error: 'too many event streams' })
    const overGlobal = await openSse('/global/event')
    expect(overGlobal.status).toBe(429)
    overGlobal.res.resume()

    // The streams already open are untouched by the refusal.
    for (const s of streams) expect(s.res.complete).toBe(false)

    // Closing one gives exactly one slot back.
    streams.pop()!.req.destroy()
    const reopened = await untilOpen('/event')
    expect(reopened.status).toBe(200)
    reopened.res.resume()
    streams.push(reopened)

    // ...and no more than one: we are at the cap again.
    const again = await openSse('/event')
    expect(again.status).toBe(429)
    again.res.resume()
  } finally {
    for (const s of streams) s.req.destroy()
  }
})

/**
 * Retry until a slot is free: the server learns about the closed connection
 * asynchronously, so the freed slot is not visible on the very next request.
 */
async function untilOpen(path: string): Promise<{ status: number; req: http.ClientRequest; res: http.IncomingMessage }> {
  const deadline = Date.now() + 5000
  for (;;) {
    const s = await openSse(path)
    if (s.status === 200) return s
    s.res.resume()
    s.req.destroy()
    if (Date.now() > deadline) return s
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/**
 * The allowlist listed '/agent' AND '/api/agent' (same for '/command' and
 * '/skill') while mountPaths() already mounts every bare template under both
 * spellings — the explicit twins only registered a second, unreachable
 * handler. Removing them must not lose a path the UI actually calls.
 */
test('the /api dialect still reaches the de-duplicated allowlist entries', async () => {
  for (const [bare, expected] of [
    ['/agent', [{ id: 'build' }]],
    ['/command', [{ id: 'cmd' }]],
    ['/skill', [{ id: 'skill' }]],
  ] as const) {
    const bareRes = await request(relay).get(bare).set('x-viewer-token', viewerToken)
    expect(bareRes.status, bare).toBe(200)
    expect(bareRes.body).toEqual(expected)
    const apiRes = await request(relay).get(`/api${bare}`).set('x-viewer-token', viewerToken)
    expect(apiRes.status, `/api${bare}`).toBe(200)
    expect(apiRes.body).toEqual(expected)
  }
  // Still no double prefix, and still authenticated.
  expect((await request(relay).get('/api/api/agent').set('x-viewer-token', viewerToken)).status).toBe(404)
  expect((await request(relay).get('/api/agent')).status).toBe(401)
})
