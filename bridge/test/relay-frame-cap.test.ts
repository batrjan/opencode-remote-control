import { afterEach, beforeEach, expect, test } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'
import { opencodeAuthHeader } from '../src/config'
import { OpencodeClient } from '../src/opencode'
import { RelayWSClient } from '../src/relay'

/**
 * The largest frame the relay accepts is the RELAY's number, and the bridge
 * has to be told it rather than carry a copy.
 *
 * A frame over the relay's maxPayload is not a failed request: ws answers it
 * with a protocol error, the relay terminates the socket, every other request
 * in flight for that share fails with it, and the viewers get a gap in their
 * event stream. The relay then repeats the GET as soon as the bridge is back,
 * so one viewer opening one heavy session costs the owner the link twice.
 *
 * So the relay announces its cap in the hello and the bridge degrades to a
 * 413 (or, for an event, to dropping that one event) instead of spending the
 * link on a frame it already knows will be refused. A relay that announces
 * nothing is an older one: the bridge keeps its own GZIP_MAX_OUTPUT_BYTES,
 * which is what those relays were built around.
 */

process.env.REMOTE_CONTROL_WS_PING_INTERVAL_MS = '10000'

const MAX_FRAME = 256 * 1024

let body = ''
let events: string[] = []
let opencode: Server
let opencodeUrl: string

beforeEach(async () => {
  body = ''
  events = []
  opencode = createServer((req, res) => {
    if (req.headers.authorization !== opencodeAuthHeader()) {
      res.writeHead(401).end()
      return
    }
    if (req.url?.startsWith('/event')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      for (const event of events) res.write(`data: ${event}\n\n`)
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(body)
  })
  await new Promise<void>((resolve) => opencode.listen(0, '127.0.0.1', resolve))
  opencodeUrl = `http://127.0.0.1:${(opencode.address() as AddressInfo).port}`
})

afterEach(async () => {
  opencode.closeAllConnections()
  await new Promise((resolve) => opencode.close(resolve))
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms
  while (!check() && Date.now() < deadline) await sleep(20)
}

interface Frame {
  type?: string
  request_id?: string
  status?: number
  data?: string
  binaryLength?: number
}

/**
 * A relay that enforces `maxPayload` the way the real one does — ws raises a
 * protocol error and the socket is terminated — and announces `features` in
 * its hello (null for a relay too old to send one at all).
 */
async function fakeRelay(features: string[] | null, maxPayload: number) {
  const wss = new WebSocketServer({ port: 0, path: '/bridge', maxPayload })
  await new Promise<void>((resolve) => wss.once('listening', resolve))
  const frames: Frame[] = []
  const state = { closes: 0, protocolErrors: 0 }
  wss.on('connection', (socket) => {
    socket.on('error', () => {
      state.protocolErrors++
      socket.terminate()
    })
    socket.on('close', () => {
      state.closes++
    })
    if (features) socket.send(JSON.stringify({ type: 'hello', features }))
    socket.on('message', (raw, isBinary) => {
      if (isBinary) {
        frames.push({ binaryLength: (raw as Buffer).length })
        return
      }
      try {
        frames.push(JSON.parse(String(raw)) as Frame)
      } catch {
        /* not ours */
      }
    })
  })
  const url = `http://127.0.0.1:${(wss.address() as AddressInfo).port}`
  return {
    url,
    frames,
    state,
    proxy: (request_id: string, path: string) => {
      for (const socket of wss.clients) socket.send(JSON.stringify({ type: 'proxy', request_id, method: 'GET', path }))
    },
    stop: () => new Promise<void>((resolve) => wss.close(() => resolve())),
  }
}

/** Ask the bridge for `body` over `relay` and return the frame that answers. */
async function ask(relay: Awaited<ReturnType<typeof fakeRelay>>, bridge: RelayWSClient, request_id: string): Promise<Frame | undefined> {
  await until(() => relay.frames.length > 0 || relay.state.closes > 0, 2000)
  relay.proxy(request_id, '/session/ses_frame_cap/message')
  await until(() => relay.frames.some((f) => f.request_id === request_id) || relay.state.closes > 0, 10_000)
  return relay.frames.find((f) => f.request_id === request_id)
}

test('a response past the announced frame cap is answered 413 instead of costing the link', async () => {
  // Compresses ~1000x, so the ratio check sends it UNCOMPRESSED (the relay
  // would refuse to inflate it) — the branch that used to put a frame four
  // times the cap on the wire.
  body = JSON.stringify([{ text: 'A'.repeat(MAX_FRAME * 4) }])
  const relay = await fakeRelay(['gzip-body', `max-frame-bytes=${MAX_FRAME}`], MAX_FRAME)
  const bridge = new RelayWSClient(relay.url, new OpencodeClient(opencodeUrl, 'opencode', process.env.OPENCODE_SERVER_PASSWORD ?? ''))
  try {
    await bridge.connect('ses_frame_cap', 'token')
    const answer = await ask(relay, bridge, 'req_raw')
    expect(answer?.status, 'the viewer gets an honest 413').toBe(413)
    expect(relay.state.protocolErrors, 'no frame past the cap was ever sent').toBe(0)
    expect(relay.state.closes, 'the owner keeps the link').toBe(0)
  } finally {
    bridge.close()
    await relay.stop()
  }
}, 30_000)

test('a compressible response whose body is past the cap is 413, not a frame the relay cannot inflate', async () => {
  // Ratio ~5, so this one WOULD be sent gzipped and fit on the wire — but the
  // relay never inflates past its own frame cap, so it would be 502 after the
  // owner's uplink had already carried it. Cheaper to say 413 up front.
  const chunk = (i: number) => `{"id":"prt_${i}","text":"lorem ipsum dolor sit amet ${Math.sin(i).toString(36)}"}`
  const parts: string[] = []
  for (let i = 0; parts.join(',').length < MAX_FRAME * 3; i++) parts.push(chunk(i))
  body = `[${parts.join(',')}]`
  const relay = await fakeRelay(['gzip-body', `max-frame-bytes=${MAX_FRAME}`], MAX_FRAME)
  const bridge = new RelayWSClient(relay.url, new OpencodeClient(opencodeUrl, 'opencode', process.env.OPENCODE_SERVER_PASSWORD ?? ''))
  try {
    await bridge.connect('ses_frame_cap', 'token')
    const answer = await ask(relay, bridge, 'req_gzip')
    expect(answer?.status).toBe(413)
    expect(relay.frames.some((f) => f.binaryLength !== undefined), 'the body was not shipped to be refused').toBe(false)
    expect(relay.state.closes).toBe(0)
  } finally {
    bridge.close()
    await relay.stop()
  }
}, 30_000)

test('an event past the announced cap is dropped, not sent into a socket it would close', async () => {
  // Events are never compressed, so a pasted image is one oversized text
  // frame. Losing that event costs the viewers one part; sending it costs
  // them the whole share until the bridge is back.
  events = [
    JSON.stringify({ type: 'message.part.updated', properties: { part: { id: 'prt_big', url: 'data:image/png;base64,' + 'A'.repeat(MAX_FRAME * 2) } } }),
    JSON.stringify({ type: 'message.part.updated', properties: { part: { id: 'prt_small' } } }),
  ]
  body = '[]'
  const relay = await fakeRelay(['gzip-body', `max-frame-bytes=${MAX_FRAME}`], MAX_FRAME)
  const bridge = new RelayWSClient(relay.url, new OpencodeClient(opencodeUrl, 'opencode', process.env.OPENCODE_SERVER_PASSWORD ?? ''))
  try {
    await bridge.connect('ses_frame_cap', 'token')
    await bridge.startEventForwarding()
    await until(() => relay.frames.some((f) => f.data?.includes('prt_small')) || relay.state.closes > 0, 10_000)
    expect(relay.frames.some((f) => f.data?.includes('prt_big')), 'the oversized event is dropped').toBe(false)
    expect(relay.frames.some((f) => f.data?.includes('prt_small')), 'the stream carries on').toBe(true)
    expect(relay.state.closes, 'the owner keeps the link').toBe(0)
  } finally {
    bridge.close()
    await relay.stop()
  }
}, 30_000)

test('a relay that announces no cap is answered exactly as before', async () => {
  // Older relays send `features: ['gzip-body']` and nothing else. Their
  // ceiling is the one every shipped bridge was built against, so nothing
  // this bridge sends them may change.
  body = JSON.stringify([{ text: 'A'.repeat(MAX_FRAME * 4) }])
  const relay = await fakeRelay(['gzip-body'], 100 * 1024 * 1024)
  const bridge = new RelayWSClient(relay.url, new OpencodeClient(opencodeUrl, 'opencode', process.env.OPENCODE_SERVER_PASSWORD ?? ''))
  try {
    await bridge.connect('ses_frame_cap', 'token')
    const answer = await ask(relay, bridge, 'req_old_relay')
    expect(answer?.status, 'the whole body still goes out in one frame').toBe(200)
    expect(relay.state.closes).toBe(0)
  } finally {
    bridge.close()
    await relay.stop()
  }
}, 30_000)
