import { afterEach, beforeEach, expect, test } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket as WsSocket } from 'ws'
import { opencodeAuthHeader } from '../src/config'
import { OpencodeClient } from '../src/opencode'
import { RelayWSClient, linkMadeProgress } from '../src/relay'

/**
 * A slow link is not a dead link.
 *
 * Found in the field: a share viewed from an iPad kept failing with
 * `502 {"error":"proxy failed"}`. nginx showed the bridge's WebSocket closing
 * every 42-43 seconds — exactly the keep-alive's two 20 s intervals plus the
 * re-dial — while stretches of minutes in between worked fine. Measured on the
 * owner's real uplink (~2 Mbit/s): at ~2 Mbit/s of outbound traffic the local
 * send queue reached 4.5 MB and pongs came back up to 3.9 s late or not at all;
 * at ~16 Mbit/s not one pong returned in 25 s.
 *
 * The cause is where the ping sits. It is written to the same socket as the
 * data, so on a saturated uplink it waits BEHIND megabytes of queued transcript
 * and never reaches the relay in time — no pong can come back, although bytes
 * are leaving the whole while. The keep-alive counted only pongs, declared the
 * link dead, terminated it, and threw away every request in flight: the viewer's
 * 502. The re-dial then did it again.
 *
 * Liveness is now PROGRESS, not pongs: an answer to our ping, anything at all
 * from the relay, or bytes that actually left our queue. Only two consecutive
 * intervals with none of those declare the link dead — the same 40 s a silent
 * link took to detect before.
 */

process.env.REMOTE_CONTROL_WS_PING_INTERVAL_MS = '60'
process.env.REMOTE_CONTROL_RECONNECT_BASE_MS = '30'
process.env.REMOTE_CONTROL_RECONNECT_MAX_MS = '120'
process.env.REMOTE_CONTROL_EVENT_RETRY_MS = '40'

let opencode: Server
let opencodeUrl: string

function json(res: import('node:http').ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

beforeEach(async () => {
  opencode = createServer((req, res) => {
    if (req.headers.authorization !== opencodeAuthHeader()) return json(res, 401, { error: 'unauthorized' })
    json(res, 200, { ok: true })
  })
  await new Promise<void>((resolve) => opencode.listen(0, '127.0.0.1', resolve))
  opencodeUrl = `http://127.0.0.1:${(opencode.address() as AddressInfo).port}`
})

afterEach(async () => {
  opencode.closeAllConnections()
  await new Promise((resolve) => opencode.close(resolve))
})

/** A stand-in relay that never answers the bridge's pings. */
async function mutedRelay(onConnection: (socket: WsSocket, raw: import('node:net').Socket) => void) {
  const wss = new WebSocketServer({ port: 0, path: '/bridge', autoPong: false })
  await new Promise<void>((resolve) => wss.once('listening', resolve))
  const sockets: WsSocket[] = []
  wss.on('connection', (socket, req) => {
    sockets.push(socket)
    onConnection(socket, req.socket)
  })
  return { wss, sockets, url: `http://127.0.0.1:${(wss.address() as AddressInfo).port}` }
}

function bridge(url: string) {
  return new RelayWSClient(url, new OpencodeClient(opencodeUrl, 'opencode', process.env.OPENCODE_SERVER_PASSWORD ?? ''))
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// ── the decision itself ─────────────────────────────────────────────────────

test('progress is any answer, any inbound traffic, or a backlog that keeps draining', () => {
  const idle = { pongReceived: false, inboundActivity: false, pendingBefore: 0, flushedBefore: 1000, flushedNow: 1000 }
  expect(linkMadeProgress(idle)).toBe(false)
  expect(linkMadeProgress({ ...idle, pongReceived: true })).toBe(true)
  expect(linkMadeProgress({ ...idle, inboundActivity: true })).toBe(true)

  const backlog = { ...idle, pendingBefore: 8_000_000 }
  // A write that was stuck behind a full OS buffer completed.
  expect(linkMadeProgress({ ...backlog, flushedNow: 5_000_000 })).toBe(true)
  // The field case: one big frame partway out. Nothing completed, so
  // bufferedAmount never moved — but the OS took 2 MB of it.
  expect(linkMadeProgress({ ...backlog, osQueueBefore: 6_000_000, osQueueNow: 4_000_000 })).toBe(true)
  // Stuck mid-write: the same bytes still waiting, nothing completed.
  expect(linkMadeProgress({ ...backlog, osQueueBefore: 6_000_000, osQueueNow: 6_000_000 })).toBe(false)
  // Where the runtime exposes no queue size, only completed writes count.
  expect(linkMadeProgress({ ...backlog, osQueueBefore: 6_000_000 })).toBe(false)

  // The trap: with no backlog, bytes leaving prove nothing. The OS accepts our
  // own pings into its buffer on a half-open link too — counting that would
  // mean a dead link is never detected.
  expect(linkMadeProgress({ ...idle, flushedNow: 1006 })).toBe(false)
})

// ── on a real socket ────────────────────────────────────────────────────────

test('a link that keeps delivering data is not killed for a missing pong', async () => {
  // The relay never pongs, but it is plainly alive: it keeps sending.
  const relay = await mutedRelay((socket) => {
    const t = setInterval(() => socket.readyState === 1 && socket.send(JSON.stringify({ type: 'noop' })), 20)
    socket.on('close', () => clearInterval(t))
  })
  const ws = bridge(relay.url)
  try {
    await ws.connect('sess-busy-inbound', 'token')
    await settle(60 * 12) // a dozen keep-alive intervals
    expect(relay.sockets.length).toBe(1)
    expect(relay.sockets[0]!.readyState).toBe(1)
  } finally {
    ws.close()
    relay.wss.close()
  }
}, 15_000)

test("the relay's own pings count as proof the link is alive", async () => {
  // Our pings go unanswered, but the relay's arrive — the path works.
  const relay = await mutedRelay((socket) => {
    const t = setInterval(() => socket.readyState === 1 && socket.ping(), 20)
    socket.on('close', () => clearInterval(t))
  })
  const ws = bridge(relay.url)
  try {
    await ws.connect('sess-relay-pings', 'token')
    await settle(60 * 12)
    expect(relay.sockets.length).toBe(1)
  } finally {
    ws.close()
    relay.wss.close()
  }
}, 15_000)

test('a link whose outbound queue is still draining is not killed', async () => {
  // The field case, with real TCP backpressure. The relay takes a small,
  // fixed number of bytes every 40 ms — a slow uplink — while the bridge has
  // megabytes queued through its real send() path, so no pong can come back:
  // our ping sits behind that queue. Bytes leave on every drip.
  //
  // Both sides are pinned down so the test means the same thing on any OS.
  // The drip is a byte budget (pause() once it is spent), not a time slice —
  // how much one resumed tick reads differs wildly between kernels. And the
  // backlog is built until it sits in THIS process, whatever the OS buffers
  // absorbed first.
  //
  // The interval is scaled up for this test only. Even a steady reader frees
  // the sender's OS buffer in steps: the socket turns writable again only once
  // a sizeable part of it is free (measured ~0.1 s apart at this drip rate on
  // macOS, more on Linux), so progress is invisible for a while between steps.
  // Production has 20 s intervals and a 40 s window against steps of a few
  // seconds on a 2 Mbit/s line; 60 ms would test the kernel, not the rule.
  const INTERVAL_MS = 500
  const savedInterval = process.env.REMOTE_CONTROL_WS_PING_INTERVAL_MS
  process.env.REMOTE_CONTROL_WS_PING_INTERVAL_MS = String(INTERVAL_MS)
  const DRIP_BYTES = 256 * 1024
  const relay = await mutedRelay((_socket, raw) => {
    let budget = 0
    raw.on('data', (chunk: Buffer) => {
      budget -= chunk.length
      if (budget <= 0) raw.pause()
    })
    raw.pause()
    const drip = setInterval(() => {
      budget = DRIP_BYTES
      raw.resume()
    }, 40)
    raw.on('close', () => clearInterval(drip))
  })
  const ws = bridge(relay.url)
  const client = ws as unknown as { send(data: unknown): void; ws: import('ws').WebSocket }
  try {
    await ws.connect('sess-draining', 'token')
    const first = client.ws
    const blob = 'x'.repeat(1024 * 1024)
    const BACKLOG = 16 * 1024 * 1024
    for (let i = 0; first.bufferedAmount < BACKLOG && i < 512; i++) {
      client.send({ type: 'proxy_response', request_id: `r${i}`, status: 200, body: blob })
      await new Promise((resolve) => setImmediate(resolve))
    }
    expect(first.bufferedAmount).toBeGreaterThanOrEqual(BACKLOG)

    // Asserted precisely rather than by "one socket at the end": the muted
    // stand-in genuinely IS dead once the queue empties, so a later re-dial is
    // correct. What must never happen is a kill while data is still queued.
    let queuedMs = 0
    let killedWhileQueued = false
    let lastQueued = first.bufferedAmount
    first.on('close', () => {
      if (lastQueued > 0) killedWhileQueued = true
    })
    const started = Date.now()
    while (Date.now() - started < 15_000 && first.readyState === 1) {
      lastQueued = first.bufferedAmount
      if (lastQueued === 0) break // drained: from here on the stand-in is legitimately silent
      await settle(20)
    }
    queuedMs = Date.now() - started
    expect(killedWhileQueued).toBe(false)
    expect(first.readyState).toBe(1)
    // And the backlog outlived what the OLD rule allowed a pong-less link (two
    // intervals) — otherwise surviving it proved nothing.
    expect(queuedMs).toBeGreaterThan(3 * INTERVAL_MS)
  } finally {
    process.env.REMOTE_CONTROL_WS_PING_INTERVAL_MS = savedInterval
    ws.close()
    relay.wss.close()
  }
}, 30_000)

test('a genuinely dead link is still detected and re-dialled', async () => {
  // Nothing comes back and nothing leaves: this is what the keep-alive is for,
  // and the progress rule must not have softened it.
  const relay = await mutedRelay(() => {})
  const ws = bridge(relay.url)
  let reconnects = 0
  ws.onReconnect = () => {
    reconnects += 1
  }
  try {
    await ws.connect('sess-dead', 'token')
    const deadline = Date.now() + 3000
    while (relay.sockets.length < 2 && Date.now() < deadline) await settle(20)
    expect(relay.sockets.length).toBeGreaterThanOrEqual(2)
    expect(reconnects).toBeGreaterThanOrEqual(1)
  } finally {
    ws.close()
    relay.wss.close()
  }
}, 15_000)

test("frames the relay sends right after accepting are not lost to the liveness listener", async () => {
  // They arrive in the same packet as the 101 response, and `ws` hands them
  // back to the socket after the upgrade. Listening for raw bytes too early
  // swallowed them — first of all the relay's hello.
  const relay = await mutedRelay((socket) => {
    // Exactly one: a later frame would mask the loss of the first.
    socket.send(JSON.stringify({ type: 'hello', features: ['gzip-body'] }))
  })
  const ws = bridge(relay.url)
  try {
    await ws.connect('sess-first-frames', 'token')
    const deadline = Date.now() + 2000
    const accepts = () => (ws as unknown as { relayAcceptsGzip: boolean }).relayAcceptsGzip
    while (!accepts() && Date.now() < deadline) await settle(10)
    expect(accepts()).toBe(true)
    // On the socket it was sent on — not recovered by a later re-dial.
    expect(relay.sockets.length).toBe(1)
  } finally {
    ws.close()
    relay.wss.close()
  }
}, 10_000)

test('a reconnect while opencode is down does not crash the bridge, and events resume once it is back', async () => {
  // On every re-dial the client restarts event forwarding. That start used to
  // be fired and forgotten: with opencode unreachable at that moment (restarting,
  // or the machine waking up) its rejection went unhandled — and Node ends the
  // process on an unhandled rejection. The share died on the very network blip
  // the reconnect was there to survive.
  const rejections: unknown[] = []
  const onRejection = (reason: unknown) => rejections.push(reason)
  process.on('unhandledRejection', onRejection)

  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = (probe.address() as AddressInfo).port
  await new Promise((resolve) => probe.close(resolve)) // nothing listens there now

  const wss = new WebSocketServer({ port: 0, path: '/bridge' })
  await new Promise<void>((resolve) => wss.once('listening', resolve))
  let connections = 0
  wss.on('connection', (socket) => {
    connections += 1
    if (connections === 1) setTimeout(() => socket.terminate(), 30) // the blip
  })
  const ws = new RelayWSClient(
    `http://127.0.0.1:${(wss.address() as AddressInfo).port}`,
    new OpencodeClient(`http://127.0.0.1:${port}`, 'opencode', process.env.OPENCODE_SERVER_PASSWORD ?? ''),
  )
  let opencodeBack: Server | undefined
  try {
    await ws.connect('sess-reconnect-opencode-down', 'token')
    const deadline = Date.now() + 3000
    while (connections < 2 && Date.now() < deadline) await settle(10)
    expect(connections).toBeGreaterThanOrEqual(2)
    await settle(200) // several event-restart attempts against a dead port
    expect(rejections).toEqual([])

    // opencode comes back on its port: forwarding picks up on its own.
    let subscribed = 0
    opencodeBack = createServer((req, res) => {
      if (req.url?.startsWith('/event')) {
        subscribed += 1
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        return
      }
      json(res, 200, {})
    })
    await new Promise<void>((resolve) => opencodeBack!.listen(port, '127.0.0.1', resolve))
    const back = Date.now() + 3000
    while (subscribed === 0 && Date.now() < back) await settle(20)
    expect(subscribed).toBeGreaterThanOrEqual(1)
    expect(rejections).toEqual([])
  } finally {
    ws.close()
    wss.close()
    opencodeBack?.closeAllConnections()
    await new Promise((resolve) => (opencodeBack ? opencodeBack.close(resolve) : resolve(undefined)))
    process.off('unhandledRejection', onRejection)
  }
}, 15_000)

test('a malformed proxy request from the relay is refused, not a crash', async () => {
  // The bridge does not trust the relay — that is why it keeps its own
  // allowlist. But the allowlist itself called method.toUpperCase() outside any
  // try, from a handler nobody awaited: one frame with a numeric method was an
  // unhandled rejection, which ends the Node process and every share with it.
  const rejections: unknown[] = []
  const onRejection = (reason: unknown) => rejections.push(reason)
  process.on('unhandledRejection', onRejection)
  const answers = new Map<string, number>()
  const wss = new WebSocketServer({ port: 0, path: '/bridge' })
  await new Promise<void>((resolve) => wss.once('listening', resolve))
  wss.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as { type: string; request_id?: string; status?: number }
      if (msg.type === 'proxy_response') answers.set(msg.request_id!, msg.status!)
    })
    for (const [request_id, method, path] of [
      ['bad-method', 7, '/session/sess-malformed/message'],
      ['bad-path', 'GET', { toString: null }],
      ['null-both', null, null],
      ['array-path', 'GET', ['/session']],
    ] as const) {
      socket.send(JSON.stringify({ type: 'proxy', request_id, method, path }))
    }
    socket.send(JSON.stringify({ type: 'proxy', request_id: 'good', method: 'GET', path: '/session/sess-malformed/message' }))
  })
  const ws = bridge(`http://127.0.0.1:${(wss.address() as AddressInfo).port}`)
  try {
    await ws.connect('sess-malformed', 'token')
    const deadline = Date.now() + 3000
    while (answers.size < 5 && Date.now() < deadline) await settle(10)
    expect(Object.fromEntries(answers)).toEqual({ 'bad-method': 403, 'bad-path': 403, 'null-both': 403, 'array-path': 403, good: 200 })
    expect(rejections).toEqual([])
  } finally {
    ws.close()
    wss.close()
    process.off('unhandledRejection', onRejection)
  }
}, 10_000)
