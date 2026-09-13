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
  // The field case, with real TCP backpressure. The relay reads its socket in
  // rare short bursts, the bridge has just sent ONE large frame through its
  // real send() path, and no pong can come back because our ping is stuck
  // behind it. Bytes leave on every drip, yet bufferedAmount cannot move until
  // the whole frame is out — the case a bufferedAmount-based rule gets wrong.
  //
  // Asserted precisely rather than by "one socket at the end": the muted
  // stand-in genuinely IS dead once the queue empties, so a later re-dial is
  // correct. What must never happen is the socket being killed while it still
  // had data queued — and the test fails as vacuous unless that draining
  // period spanned several keep-alive intervals.
  const relay = await mutedRelay((_socket, raw) => {
    raw.pause()
    const drip = setInterval(() => {
      raw.resume()
      setImmediate(() => raw.pause())
    }, 40)
    raw.on('close', () => clearInterval(drip))
  })
  const ws = bridge(relay.url)
  const client = ws as unknown as { send(data: unknown): void; ws: import('ws').WebSocket }
  try {
    await ws.connect('sess-draining', 'token')
    const first = client.ws
    client.send({ type: 'proxy_response', request_id: 'r1', status: 200, body: 'x'.repeat(48 * 1024 * 1024) })

    let queuedSamples = 0
    let killedWhileQueued = false
    let lastQueued = first.bufferedAmount
    first.on('close', () => {
      if (lastQueued > 0) killedWhileQueued = true
    })
    const deadline = Date.now() + 4000
    while (Date.now() < deadline && first.readyState === 1) {
      lastQueued = first.bufferedAmount
      if (lastQueued > 0) queuedSamples += 1
      else break // drained: from here on the stand-in is legitimately silent
      await settle(20)
    }
    // Data stayed queued past the point the OLD rule killed a pong-less link
    // (two 60 ms intervals) — otherwise surviving it would prove nothing…
    const INTERVAL_MS = 60
    expect(queuedSamples * 20).toBeGreaterThan(2 * INTERVAL_MS)
    // …and the socket was never torn down with that data still on it.
    expect(killedWhileQueued).toBe(false)
  } finally {
    ws.close()
    relay.wss.close()
  }
}, 20_000)

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
