import { afterEach, beforeEach, expect, test } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'
import request from 'supertest'
import { WebSocket } from 'ws'
import { startServer } from '../src/server'
import { GZIP_MAX_RATIO } from '../src/ws/bridge'
import { OpencodeClient } from '../../bridge/src/opencode'
import { RelayWSClient } from '../../bridge/src/relay'

/**
 * Compressed response bodies, bridge → relay.
 *
 * The owner's uplink is the narrowest pipe on the path, and what crosses it is
 * mostly JSON transcript. The bridge now gzips large bodies — but only toward
 * a relay that announced it can read them, and never beyond the expansion the
 * relay is willing to perform, because any registration can be a hostile
 * "bridge" and an unbounded inflate is a decompression bomb.
 */

const API_KEY = 'test-relay-key'
process.env.RELAY_API_KEY = API_KEY

let relay: Server
let relayUrl: string
let opencode: Server
let opencodeUrl: string
let transcript = ''

function json(res: import('node:http').ServerResponse, status: number, body: string) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(body)
}

beforeEach(async () => {
  relay = await startServer(0)
  relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`
  opencode = createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    if (url.pathname.endsWith('/message')) return json(res, 200, transcript)
    if (url.pathname.startsWith('/session/')) return json(res, 200, JSON.stringify({ id: 'x', title: 't', parentID: 'p' }))
    return json(res, 404, '{}')
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
    .send({ session_id, directory: '/path', title: 'gzip' })
  expect(created.status).toBe(201)
  const activated = await request(relay).post('/api/activate').send({ code: created.body.access_code, session_id })
  expect(activated.status).toBe(200)
  return { bridgeToken: created.body.bridge_token as string, viewerToken: activated.body.viewer_token as string }
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

/** Watch every frame the relay receives from bridges, without touching them. */
function tapBridgeFrames() {
  const frames: { binary: boolean; bytes: number }[] = []
  relay.on('upgrade', (_req, socket) => {
    socket.on('data', (chunk: Buffer) => frames.push({ binary: false, bytes: chunk.length }))
  })
  return frames
}

test('a large body crosses compressed and reaches the viewer byte-for-byte', async () => {
  transcript = makeTranscript(3000)
  const { bridgeToken, viewerToken } = await share('ses_gzip')
  const wire = tapBridgeFrames()
  const bridge = new RelayWSClient(relayUrl, new OpencodeClient(opencodeUrl, 'opencode', process.env.OPENCODE_SERVER_PASSWORD ?? ''))
  try {
    await bridge.connect('ses_gzip', bridgeToken)
    const res = await request(relay).get('/session/ses_gzip/message').set('x-viewer-token', viewerToken)
    expect(res.status).toBe(200)
    expect(res.text).toBe(transcript)
    // What actually crossed the bridge link was a fraction of the body.
    const onWire = wire.reduce((n, f) => n + f.bytes, 0)
    expect(onWire).toBeLessThan(transcript.length / 3)
  } finally {
    bridge.close()
  }
}, 20_000)

test('bodies the relay transforms are decoded before the transform runs', async () => {
  // /session/:id is rewritten by the relay (parentID stripped), so it must see
  // the inflated JSON, not the gzip bytes.
  const { bridgeToken, viewerToken } = await share('ses_gzip_detail')
  const bridge = new RelayWSClient(relayUrl, new OpencodeClient(opencodeUrl, 'opencode', process.env.OPENCODE_SERVER_PASSWORD ?? ''))
  const big = { id: 'ses_gzip_detail', title: 'x'.repeat(10) + makeTranscript(200), parentID: 'ses_parent' }
  opencode.removeAllListeners('request')
  opencode.on('request', (_req, res) => json(res, 200, JSON.stringify(big)))
  try {
    await bridge.connect('ses_gzip_detail', bridgeToken)
    const res = await request(relay).get('/session/ses_gzip_detail').set('x-viewer-token', viewerToken)
    expect(res.status).toBe(200)
    expect(res.body.title).toBe(big.title)
    expect(res.body.parentID).toBeUndefined()
  } finally {
    bridge.close()
  }
}, 20_000)

test('a body that compresses past the relay limit is sent uncompressed, and still arrives', async () => {
  transcript = JSON.stringify({ blob: 'a'.repeat(4 * 1024 * 1024) }) // ~1000x compressible
  const { bridgeToken, viewerToken } = await share('ses_gzip_extreme')
  const bridge = new RelayWSClient(relayUrl, new OpencodeClient(opencodeUrl, 'opencode', process.env.OPENCODE_SERVER_PASSWORD ?? ''))
  try {
    await bridge.connect('ses_gzip_extreme', bridgeToken)
    const res = await request(relay).get('/session/ses_gzip_extreme/message').set('x-viewer-token', viewerToken)
    expect(res.status).toBe(200)
    expect(res.text).toBe(transcript)
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
  return { ws, frames, nextProxy }
}

function compressedFrame(header: Record<string, unknown>, body: Buffer): Buffer {
  const h = Buffer.from(JSON.stringify(header))
  const prefix = Buffer.alloc(4)
  prefix.writeUInt32BE(h.length, 0)
  return Buffer.concat([prefix, h, body])
}

test('the relay announces gzip support in its first frame', async () => {
  const { bridgeToken } = await share('ses_hello')
  const { ws, frames } = await rawBridge('ses_hello', bridgeToken)
  try {
    const deadline = Date.now() + 2000
    while (frames.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
    expect(frames[0]).toEqual({ type: 'hello', features: ['gzip-body'] })
  } finally {
    ws.terminate()
  }
})

test('a decompression bomb fails only its own request and costs the relay a bounded inflate', async () => {
  const { bridgeToken, viewerToken } = await share('ses_bomb')
  const { ws, nextProxy } = await rawBridge('ses_bomb', bridgeToken)
  try {
    // 64 MB of zeros gzip to ~64 KB: a thousandfold expansion, far past the cap.
    const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024))
    expect(bomb.length * GZIP_MAX_RATIO).toBeLessThan(64 * 1024 * 1024)

    const pendingView = request(relay).get('/session/ses_bomb/message').set('x-viewer-token', viewerToken)
    const answered = pendingView.then((r) => r)
    const proxied = await nextProxy()
    ws.send(
      compressedFrame({ type: 'proxy_response', request_id: proxied.request_id, status: 200, contentType: 'application/json', encoding: 'gzip' }, bomb),
      { binary: true },
    )
    const res = await answered
    expect(res.status).toBe(502)

    // The relay is fine and the same bridge keeps working for honest answers.
    expect((await request(relay).get('/health')).status).toBe(200)
    const second = request(relay).get('/session/ses_bomb/message').set('x-viewer-token', viewerToken).then((r) => r)
    const again = await nextProxy()
    const honest = makeTranscript(500)
    ws.send(
      compressedFrame({ type: 'proxy_response', request_id: again.request_id, status: 200, contentType: 'application/json', encoding: 'gzip' }, gzipSync(honest)),
      { binary: true },
    )
    const ok = await second
    expect(ok.status).toBe(200)
    expect(ok.text).toBe(honest)
  } finally {
    ws.terminate()
  }
}, 30_000)

test('malformed or foreign compressed frames are dropped without harm', async () => {
  const a = await share('ses_frames_a')
  const b = await share('ses_frames_b')
  const bridgeA = await rawBridge('ses_frames_a', a.bridgeToken)
  const bridgeB = await rawBridge('ses_frames_b', b.bridgeToken)
  try {
    const viewA = request(relay).get('/session/ses_frames_a/message').set('x-viewer-token', a.viewerToken).then((r) => r)
    const proxied = await bridgeA.nextProxy()
    const good = gzipSync('[{"id":"from-a"}]')
    const junk: Buffer[] = [
      Buffer.alloc(0),
      Buffer.from([0, 0]),
      Buffer.from([0xff, 0xff, 0xff, 0xff, 1, 2, 3]), // header length far past the frame
      compressedFrame({ nope: true }, good),
      Buffer.concat([Buffer.from([0, 0, 0, 3]), Buffer.from('{{{'), good]), // header is not JSON
      compressedFrame({ type: 'proxy_response', request_id: proxied.request_id, status: 200, encoding: 'br' }, good),
      compressedFrame({ type: 'proxy_response', request_id: 'not-pending', status: 200, encoding: 'gzip' }, good),
    ]
    for (const frame of junk) bridgeA.ws.send(frame, { binary: true })
    // Session B tries to answer A's request with a compressed body.
    bridgeB.ws.send(
      compressedFrame({ type: 'proxy_response', request_id: proxied.request_id, status: 200, encoding: 'gzip' }, gzipSync('[{"id":"forged-by-b"}]')),
      { binary: true },
    )
    await new Promise((resolve) => setTimeout(resolve, 200))
    // A's real answer still lands: none of the above consumed the request.
    bridgeA.ws.send(
      compressedFrame({ type: 'proxy_response', request_id: proxied.request_id, status: 200, contentType: 'application/json', encoding: 'gzip' }, good),
      { binary: true },
    )
    const res = await viewA
    expect(res.status).toBe(200)
    expect(res.body).toEqual([{ id: 'from-a' }])
    expect(bridgeA.ws.readyState).toBe(WebSocket.OPEN)
  } finally {
    bridgeA.ws.terminate()
    bridgeB.ws.terminate()
  }
}, 20_000)

test('a bridge that never heard the hello keeps sending plain JSON', async () => {
  // An older relay: accepts the socket, never announces anything.
  const { WebSocketServer } = await import('ws')
  const wss = new WebSocketServer({ port: 0, path: '/bridge' })
  await new Promise<void>((resolve) => wss.once('listening', resolve))
  const kinds: boolean[] = []
  let answer: (v: unknown) => void = () => {}
  const answered = new Promise((resolve) => (answer = resolve))
  wss.on('connection', (socket) => {
    socket.on('message', (raw, isBinary) => {
      kinds.push(isBinary)
      if (!isBinary) answer(JSON.parse(String(raw)))
    })
    socket.send(JSON.stringify({ type: 'proxy', request_id: 'r1', method: 'GET', path: '/session/ses_old/message' }))
  })
  transcript = makeTranscript(3000)
  const bridge = new RelayWSClient(
    `http://127.0.0.1:${(wss.address() as AddressInfo).port}`,
    new OpencodeClient(opencodeUrl, 'opencode', process.env.OPENCODE_SERVER_PASSWORD ?? ''),
  )
  try {
    await bridge.connect('ses_old', 'token')
    const msg = (await answered) as { type: string; body: string }
    expect(msg.type).toBe('proxy_response')
    expect(msg.body).toBe(transcript)
    expect(kinds).toEqual([false])
  } finally {
    bridge.close()
    wss.close()
  }
}, 20_000)
