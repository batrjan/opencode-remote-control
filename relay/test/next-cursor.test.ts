import { afterEach, beforeEach, expect, test } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'
import request from 'supertest'
import { viewerTokenFrom } from './helpers/viewer-token'
import { WebSocket } from 'ws'
import { startServer } from '../src/server'
import { OpencodeClient } from '../../bridge/src/opencode'
import { RelayWSClient } from '../../bridge/src/relay'

/**
 * Older transcript history, page by page.
 *
 * opencode (1.18.30) pages GET /session/:id/message?limit=N and says whether
 * an older page exists ONLY in the X-Next-Cursor (and Link) response header;
 * the body is a bare array. The web UI takes the page as the whole history
 * when that header is missing: it never offers the scroll-up loader. The
 * bridge → relay protocol carried status, content type and body and nothing
 * else, so every shared session with more than the UI's first 20 messages
 * showed the last 20 and there was no way to reach the older ones — in the
 * shared session and in its subagents alike. Measured against a real opencode
 * with 27 messages: the viewer's list started at message 8, while a proxy
 * that only re-added the header let the UI load back to message 1.
 *
 * The cursor now crosses the link as its own field. Link does not: it spells
 * out the owner's local opencode URL and the absolute project directory.
 */

const API_KEY = 'test-relay-key'
process.env.RELAY_API_KEY = API_KEY

/** Shaped like opencode's own cursor: base64url of {"id","time"}. */
const CURSOR = 'eyJpZCI6Im1zZ18wOWJlOWI1MWIwMDEyT01QZ0VNWFBzTm45YyIsInRpbWUiOjE3ODkzMjIxNzk4Njd9'

let relay: Server
let relayUrl: string
let opencode: Server
let opencodeUrl: string
/** What the mock answers for a message list: body and whether a page follows. */
let page: { body: string; cursor?: string } = { body: '[]' }

beforeEach(async () => {
  relay = await startServer(0)
  relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`
  opencode = createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    if (req.method === 'GET' && url.pathname.endsWith('/message')) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (page.cursor) {
        // What opencode 1.18.30 sends when an older page exists.
        headers['Access-Control-Expose-Headers'] = 'Link, X-Next-Cursor'
        headers.Link = `<http://127.0.0.1:4096${url.pathname}?limit=2&directory=%2Fhome%2Fowner%2Fsecret-project&before=${page.cursor}>; rel="next"`
        headers['X-Next-Cursor'] = page.cursor
      }
      res.writeHead(200, headers)
      res.end(page.body)
      return
    }
    // Session detail drives the relay's subagent ancestry walk.
    if (req.method === 'GET' && url.pathname === '/session/ses_page_child') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: 'ses_page_child', parentID: 'ses_page', title: 'subagent' }))
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end('{}')
  })
  await new Promise<void>((resolve) => opencode.listen(0, '127.0.0.1', resolve))
  opencodeUrl = `http://127.0.0.1:${(opencode.address() as AddressInfo).port}`
})

afterEach(async () => {
  relay.closeAllConnections()
  await new Promise((resolve) => relay.close(resolve))
  opencode.closeAllConnections()
  await new Promise((resolve) => opencode.close(resolve))
})

async function share(session_id: string) {
  const created = await request(relay)
    .post('/api/sessions')
    .set('x-api-key', API_KEY)
    .send({ session_id, directory: '/path', title: 'paging' })
  expect(created.status).toBe(201)
  const activated = await request(relay).post('/api/activate').send({ code: created.body.access_code, session_id })
  expect(activated.status).toBe(200)
  return { bridgeToken: created.body.bridge_token as string, viewerToken: viewerTokenFrom(activated) }
}

async function realBridge(session_id: string, bridgeToken: string) {
  const bridge = new RelayWSClient(relayUrl, new OpencodeClient(opencodeUrl, 'opencode', process.env.OPENCODE_SERVER_PASSWORD ?? ''))
  await bridge.connect(session_id, bridgeToken)
  return bridge
}

/** A transcript-shaped body: repetitive structure, varied text. */
function makeTranscript(messages: number): string {
  return JSON.stringify(
    Array.from({ length: messages }, (_, i) => ({
      info: { id: `msg_${i}`, role: i % 2 ? 'assistant' : 'user', time: { created: 1_757_000_000_000 + i * 997 } },
      parts: [{ id: `prt_${i}`, type: 'text', text: `Step ${i}: ${Math.sin(i).toString(36)} ${'lorem ipsum '.repeat(i % 7)}` }],
    })),
  )
}

test('a page with older history reaches the viewer with its cursor, and without Link', async () => {
  page = { body: JSON.stringify([{ info: { id: 'm4' }, parts: [] }]), cursor: CURSOR }
  const { bridgeToken, viewerToken } = await share('ses_page')
  const bridge = await realBridge('ses_page', bridgeToken)
  try {
    const res = await request(relay).get('/session/ses_page/message?limit=2').set('x-viewer-token', viewerToken)
    expect(res.status).toBe(200)
    expect(res.body).toEqual([{ info: { id: 'm4' }, parts: [] }])
    expect(res.headers['x-next-cursor']).toBe(CURSOR)
    expect(res.headers['link']).toBeUndefined()
  } finally {
    bridge.close()
  }
}, 20_000)

test('the cursor survives a body large enough to cross the link compressed', async () => {
  page = { body: makeTranscript(3000), cursor: CURSOR }
  const { bridgeToken, viewerToken } = await share('ses_page')
  const wire: number[] = []
  relay.on('upgrade', (_req, socket) => socket.on('data', (chunk: Buffer) => wire.push(chunk.length)))
  const bridge = await realBridge('ses_page', bridgeToken)
  try {
    const res = await request(relay).get('/session/ses_page/message?limit=20').set('x-viewer-token', viewerToken)
    expect(res.status).toBe(200)
    expect(res.text).toBe(page.body)
    // It really took the gzip frame: a fraction of the body crossed the link.
    expect(wire.reduce((n, b) => n + b, 0)).toBeLessThan(page.body.length / 3)
    expect(res.headers['x-next-cursor']).toBe(CURSOR)
    expect(res.headers['link']).toBeUndefined()
  } finally {
    bridge.close()
  }
}, 20_000)

test("a subagent's transcript pages the same way", async () => {
  page = { body: JSON.stringify([{ info: { id: 'child-m9' }, parts: [] }]), cursor: CURSOR }
  const { bridgeToken, viewerToken } = await share('ses_page')
  const bridge = await realBridge('ses_page', bridgeToken)
  try {
    const res = await request(relay).get('/session/ses_page_child/message?limit=2').set('x-viewer-token', viewerToken)
    expect(res.status).toBe(200)
    expect(res.body).toEqual([{ info: { id: 'child-m9' }, parts: [] }])
    expect(res.headers['x-next-cursor']).toBe(CURSOR)
  } finally {
    bridge.close()
  }
}, 20_000)

test('the last page carries no cursor', async () => {
  page = { body: JSON.stringify([{ info: { id: 'm1' }, parts: [] }]) }
  const { bridgeToken, viewerToken } = await share('ses_page')
  const bridge = await realBridge('ses_page', bridgeToken)
  try {
    const res = await request(relay).get('/session/ses_page/message?limit=2').set('x-viewer-token', viewerToken)
    expect(res.status).toBe(200)
    expect(res.headers['x-next-cursor']).toBeUndefined()
  } finally {
    bridge.close()
  }
}, 20_000)

/** A hand-driven bridge: sees the relay's frames, sends whatever it likes. */
async function rawBridge(session_id: string, bridgeToken: string) {
  const ws = new WebSocket(`${relayUrl.replace(/^http/, 'ws')}/bridge?session_id=${session_id}`, {
    headers: { 'x-bridge-token': bridgeToken },
  })
  const frames: Record<string, unknown>[] = []
  ws.on('message', (raw) => frames.push(JSON.parse(String(raw))))
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const nextProxy = async () => {
    const deadline = Date.now() + 3000
    for (;;) {
      const i = frames.findIndex((f) => f.type === 'proxy')
      if (i !== -1) return frames.splice(i, 1)[0] as { request_id: string }
      if (Date.now() > deadline) throw new Error('no proxy request arrived')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  return { ws, nextProxy }
}

function compressedFrame(header: Record<string, unknown>, body: Buffer): Buffer {
  const h = Buffer.from(JSON.stringify(header))
  const prefix = Buffer.alloc(4)
  prefix.writeUInt32BE(h.length, 0)
  return Buffer.concat([prefix, h, body])
}

test('a cursor that is not a plain token never becomes a response header', async () => {
  // Registration is public, so the "bridge" may be anyone, and the cursor is
  // reflected into the viewer's response headers.
  const { bridgeToken, viewerToken } = await share('ses_page')
  const { ws, nextProxy } = await rawBridge('ses_page', bridgeToken)
  const hostile: unknown[] = [
    `${CURSOR}\r\nSet-Cookie: viewer_token=stolen`,
    'CUR SOR',
    'x'.repeat(4096),
    '',
    42,
    { cursor: CURSOR },
  ]
  try {
    for (const nextCursor of hostile) {
      for (const encoding of ['json', 'gzip'] as const) {
        const view = request(relay).get('/session/ses_page/message?limit=2').set('x-viewer-token', viewerToken).then((r) => r)
        const proxied = await nextProxy()
        const body = '[{"id":"m1"}]'
        if (encoding === 'json') {
          ws.send(JSON.stringify({ type: 'proxy_response', request_id: proxied.request_id, status: 200, contentType: 'application/json', nextCursor, body }))
        } else {
          ws.send(
            compressedFrame(
              { type: 'proxy_response', request_id: proxied.request_id, status: 200, contentType: 'application/json', nextCursor, encoding: 'gzip' },
              gzipSync(body),
            ),
            { binary: true },
          )
        }
        const res = await view
        expect(res.status, `${encoding} ${JSON.stringify(nextCursor)}`).toBe(200)
        expect(res.body).toEqual([{ id: 'm1' }])
        expect(res.headers['x-next-cursor']).toBeUndefined()
        expect(res.headers['set-cookie']).toBeUndefined()
      }
    }
    // A well-formed cursor from the same hand-driven bridge does pass.
    const view = request(relay).get('/session/ses_page/message?limit=2').set('x-viewer-token', viewerToken).then((r) => r)
    const proxied = await nextProxy()
    ws.send(JSON.stringify({ type: 'proxy_response', request_id: proxied.request_id, status: 200, nextCursor: CURSOR, body: '[]' }))
    expect((await view).headers['x-next-cursor']).toBe(CURSOR)
    expect((await request(relay).get('/health')).status).toBe(200)
    expect(ws.readyState).toBe(WebSocket.OPEN)
  } finally {
    ws.terminate()
  }
}, 30_000)
