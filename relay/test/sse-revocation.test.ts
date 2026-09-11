import { afterAll, beforeAll, expect, test } from 'vitest'
import http, { createServer } from 'node:http'
import net from 'node:net'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import { startServer } from '../src/server'
import { OpencodeClient } from '../../bridge/src/opencode'
import { RelayWSClient } from '../../bridge/src/relay'

/**
 * An SSE stream authenticates ONCE, at open, and then lives for hours. That
 * makes it the place where the relay's revocations quietly stopped applying:
 * a viewer whose token was evicted, aged out, or whose whole share was deleted
 * kept receiving the owner's live events on the connection it already held,
 * while every HTTP request it made correctly 401'd.
 *
 * The sharpest form: a share is stopped and the SAME opencode session is
 * shared again later (the session id is opencode's, so it is reused). A viewer
 * from the first share — revoked, holding a dead code — silently resumed
 * receiving the second share's events. These tests pin the re-validation that
 * closes the stream, and the slot accounting that was leaking alongside it.
 */

let relay: Server
let relayUrl: string
let opencode: Server
let bridge: RelayWSClient
let bridgeToken: string
let viewerToken: string

/** Shrunk so a test does not wait 15 s for the re-validation tick. */
process.env.RELAY_SSE_HEARTBEAT_MS = '80'
process.env.ACTIVATE_FAIL_DELAY_MS = '0'

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

beforeAll(async () => {
  opencode = createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    if (url.pathname === '/event') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: {"type":"server.connected","properties":{}}\n\n')
      return
    }
    json(res, 200, { ok: true })
  })
  await new Promise<void>((resolve) => opencode.listen(0, '127.0.0.1', resolve))
  const opencodePort = (opencode.address() as AddressInfo).port

  relay = await startServer(0)
  relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`

  const created = await request(relay)
    .post('/api/sessions')
    .send({ session_id: 'ses_revoke1', directory: '/work', title: 't' })
  expect(created.status).toBe(201)
  bridgeToken = created.body.bridge_token
  const activated = await request(relay)
    .post('/api/activate')
    .send({ code: created.body.access_code, session_id: 'ses_revoke1' })
  expect(activated.status).toBe(200)
  viewerToken = activated.body.viewer_token

  bridge = new RelayWSClient(
    relayUrl,
    new OpencodeClient(`http://127.0.0.1:${opencodePort}`, 'opencode', ''),
  )
  await bridge.connect('ses_revoke1', bridgeToken)
})

afterAll(async () => {
  bridge.close()
  relay.closeAllConnections()
  await new Promise((resolve) => relay.close(resolve))
  opencode.closeAllConnections()
  await new Promise((resolve) => opencode.close(resolve))
})

/**
 * Open an SSE stream and report when the RESPONSE ends.
 *
 * Deliberately not a raw socket: `res.end()` terminates the chunked body but
 * HTTP keep-alive leaves the TCP connection open, so watching the socket would
 * never see the stream close. fetch's body reader reports exactly the event
 * that matters — the server stopped streaming to this viewer.
 */
async function openStream(token: string): Promise<{ abort: () => void; ended: () => boolean; body: () => string }> {
  const controller = new AbortController()
  const res = await fetch(`${relayUrl}/event`, {
    headers: { 'x-viewer-token': token, accept: 'text/event-stream' },
    signal: controller.signal,
  })
  if (res.status !== 200) {
    controller.abort()
    throw new Error(`stream refused: ${res.status}`)
  }
  let done = false
  let text = ''
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  void (async () => {
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        text += decoder.decode(chunk.value, { stream: true })
      }
    } catch {
      // aborted by the test, or the connection dropped — either way it is over
    } finally {
      done = true
    }
  })()
  return { abort: () => controller.abort(), ended: () => done, body: () => text }
}

/** MAX_STREAMS_PER_SESSION in relay/src/proxy/adapter.ts. */
const STREAM_CAP = 64

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('deleting the share closes a viewer stream that is already open', async () => {
  const stream = await openStream(viewerToken)
  expect(stream.ended()).toBe(false)

  const deleted = await request(relay)
    .delete('/api/sessions/ses_revoke1')
    .set('x-bridge-token', bridgeToken)
  expect(deleted.status).toBe(204)

  // Within one heartbeat tick the stream must be gone: the token no longer
  // resolves to a session, so the re-validation ends the response.
  await settle(500)
  expect(stream.ended()).toBe(true)

  // And the HTTP path agrees.
  const after = await request(relay).get('/config').set('x-viewer-token', viewerToken)
  expect(after.status).toBe(401)
})

test('a re-shared session does not resurrect the previous share viewer stream', async () => {
  // Same opencode session id, brand new share: a new access code, a new bridge
  // token, new viewers. The old viewer must stay out — of the HTTP API AND of
  // the live feed.
  const recreated = await request(relay)
    .post('/api/sessions')
    .send({ session_id: 'ses_revoke1', directory: '/work', title: 't' })
  expect(recreated.status).toBe(201)

  const stale = await request(relay).get('/config').set('x-viewer-token', viewerToken)
  expect(stale.status).toBe(401)

  // The old token cannot even open a stream on the new share.
  await expect(openStream(viewerToken)).rejects.toThrow(/stream refused: 401/)

  await request(relay)
    .delete('/api/sessions/ses_revoke1')
    .set('x-bridge-token', recreated.body.bridge_token)
})

test('a stream aborted before the handler runs does not leak its slot', async () => {
  // The leak this pins: express walks its stack (express.static stats the
  // filesystem) before this router sees the request, and a client that hangs
  // up in that window has ALREADY fired 'close' on req and res — so the
  // release listeners never ran and the slot was gone for the life of the
  // process. The assertion is therefore the FULL cap, not "one more stream
  // opens": after the aborts every one of the 64 slots must still be free,
  // which is the only way to notice a handful of them leaking.
  const created = await request(relay)
    .post('/api/sessions')
    .send({ session_id: 'ses_abort1', directory: '/work', title: 't' })
  expect(created.status).toBe(201)
  const activated = await request(relay)
    .post('/api/activate')
    .send({ code: created.body.access_code, session_id: 'ses_abort1' })
  const token = activated.body.viewer_token as string

  const port = (relay.address() as AddressInfo).port
  // Fired in parallel batches and torn down inside the dispatch window.
  for (let round = 0; round < 10; round++) {
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        new Promise<void>((resolve) => {
          const socket = net.connect(port, '127.0.0.1', () => {
            socket.write(
              'GET /event HTTP/1.1\r\n' +
                `Host: 127.0.0.1:${port}\r\n` +
                `x-viewer-token: ${token}\r\n\r\n`,
            )
            // 0 ms lands inside express's own stack walk on most runs; the
            // spread covers the rest of the window.
            setTimeout(() => {
              socket.destroy()
              resolve()
            }, i % 7)
          })
          socket.on('error', () => resolve())
        }),
      ),
    )
  }
  await settle(400)

  // Every slot must be free: 64 concurrent streams, all accepted.
  const streams = []
  for (let i = 0; i < STREAM_CAP; i++) streams.push(await openStream(token))
  expect(streams.length).toBe(STREAM_CAP)
  expect(streams.every((s) => !s.ended())).toBe(true)
  for (const s of streams) s.abort()
  await settle(200)

  await request(relay)
    .delete('/api/sessions/ses_abort1')
    .set('x-bridge-token', created.body.bridge_token)
})
