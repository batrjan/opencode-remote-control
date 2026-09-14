import { afterEach, beforeEach, expect, test } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import { viewerTokenFrom } from './helpers/viewer-token'
import { WebSocket } from 'ws'
import { createApp } from '../src/server'
import { Store } from '../src/store'
import { BridgeClient } from '../src/ws/bridge'

/**
 * The stuck-viewer cap exempts ONE large frame still waiting in the backlog so
 * a pasted image or a big diff reaches a viewer that keeps reading. But the
 * exemption was unbounded in both size and time: a viewer that took a single
 * oversized event and then read nothing kept that whole frame buffered for as
 * long as its TCP connection lived, because only the ~150-byte heartbeats were
 * ever counted against the cap and they never reach it. A single ws frame is
 * bounded only by the relay's maxPayload (100 MiB by default), and an
 * anonymous owner may hold 64 non-reading streams on one token, so one 100 MiB
 * global event held ~6.4 GB and OOM'd the relay and every share on it.
 *
 * Two complementary fixes, both exercised here:
 *  - a heartbeat "no progress" watchdog that ignores the exemption: a stream
 *    holding more than the cap that drains nothing between two beats is stuck,
 *    so it is dropped within a beat instead of pinning the frame forever;
 *  - a bound on how much of one frame is exempt, so a frame larger than that
 *    trips the ordinary per-write check on the very next frame.
 */

process.env.ACTIVATE_FAIL_DELAY_MS = '0'

const KiB = 1024
const MiB = 1024 * 1024

let relay: http.Server
let relayUrl: string
let savedHeartbeat: string | undefined
let savedExempt: string | undefined
/** Relay-side responses of every viewer event stream, in arrival order. */
let streams: { res: http.ServerResponse; peak: number; writes: number }[]

beforeEach(async () => {
  streams = []
  // Fast heartbeats so the watchdog fires in test time rather than 15 s.
  savedHeartbeat = process.env.RELAY_SSE_HEARTBEAT_MS
  process.env.RELAY_SSE_HEARTBEAT_MS = '120'
  savedExempt = process.env.RELAY_SSE_MAX_EXEMPT_BYTES
  const store = new Store()
  relay = http.createServer()
  const bridge = new BridgeClient(relay, store)
  // Registered before the app so it sees each response first and can record
  // the largest backlog the relay ever held for that viewer.
  relay.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
    if (req.url !== '/event') return
    const entry = { res, peak: 0, writes: 0 }
    streams.push(entry)
    const write = res.write.bind(res) as (...args: unknown[]) => boolean
    res.write = ((...args: unknown[]) => {
      const ok = write(...args)
      entry.writes++
      entry.peak = Math.max(entry.peak, res.writableLength)
      return ok
    }) as typeof res.write
  })
  relay.on('request', createApp(store, bridge))
  relay.on('close', () => bridge.close())
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve))
  relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`
})

afterEach(async () => {
  relay.closeAllConnections()
  await new Promise((resolve) => relay.close(resolve))
  if (savedHeartbeat === undefined) delete process.env.RELAY_SSE_HEARTBEAT_MS
  else process.env.RELAY_SSE_HEARTBEAT_MS = savedHeartbeat
  if (savedExempt === undefined) delete process.env.RELAY_SSE_MAX_EXEMPT_BYTES
  else process.env.RELAY_SSE_MAX_EXEMPT_BYTES = savedExempt
})

/** Register a share, join it once, and connect its bridge. */
async function share(id: string) {
  const created = await request(relay).post('/api/sessions').send({ session_id: id, directory: '/work', title: 't' })
  expect(created.status).toBe(201)
  const { access_code, bridge_token } = created.body as { access_code: string; bridge_token: string }
  const act = await request(relay).post('/api/activate').send({ code: access_code, session_id: id })
  const viewerToken = viewerTokenFrom(act)
  const bridge = new WebSocket(`${relayUrl.replace(/^http/, 'ws')}/bridge?session_id=${id}`, {
    headers: { 'x-bridge-token': bridge_token },
  })
  await new Promise((resolve, reject) => {
    bridge.once('open', resolve)
    bridge.once('error', reject)
  })
  return { viewerToken, bridge }
}

/** A raw viewer connection to /event, so the test decides when it reads. */
async function openViewer(token: string): Promise<net.Socket> {
  const socket = net.connect((relay.address() as AddressInfo).port, '127.0.0.1')
  await new Promise((resolve) => socket.once('connect', resolve))
  socket.write(`GET /event HTTP/1.1\r\nHost: x\r\nx-viewer-token: ${token}\r\n\r\n`)
  return socket
}

/** Everything a raw viewer socket has received so far, as text. */
function collect(socket: net.Socket): () => string {
  const chunks: Buffer[] = []
  socket.on('data', (chunk: Buffer) => chunks.push(chunk))
  return () => Buffer.concat(chunks).toString('latin1')
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(check: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms
  while (!check() && Date.now() < deadline) await sleep(20)
}

/** One `message.part.updated` carrying a data-URL blob of `bytes`. */
function bigPartEvent(id: string, bytes: number): string {
  const url = 'data:image/png;base64,' + 'A'.repeat(bytes)
  return JSON.stringify({
    type: 'message.part.updated',
    properties: { part: { id: 'prt_big', messageID: 'msg_big', sessionID: id, type: 'file', url } },
  })
}

test('a non-reading viewer that parked one oversized event is dropped, not pinned forever', async () => {
  // On HEAD the exemption is unbounded in time: the big frame is exempt, only
  // the tiny heartbeats are counted, and they never reach the 2 MiB cap, so
  // the stream stays alive holding the whole frame for the life of its TCP
  // connection. The watchdog drops it within a couple of beats instead.
  const id = 'ses_exempt_stall'
  const { viewerToken, bridge } = await share(id)
  const stuck = await openViewer(viewerToken)
  stuck.pause() // takes the event into the kernel buffer, then never reads
  try {
    await until(() => streams.length === 1, 2000)
    expect(streams.length).toBe(1)

    // 6 MiB: well past the 2 MiB cap, but inside the default exempt bound, so
    // ONLY the no-progress watchdog can catch it — not the per-write check.
    bridge.send(JSON.stringify({ type: 'event', data: bigPartEvent(id, 6 * MiB) }))
    await until(() => streams[0].peak > 4 * MiB, 5000)
    expect(streams[0].peak).toBeGreaterThan(4 * MiB) // the frame really landed

    // Several heartbeats pass with the viewer reading nothing.
    await until(() => streams[0].res.destroyed, 5000)
    expect(streams[0].res.destroyed).toBe(true)
  } finally {
    bridge.terminate()
    stuck.destroy()
  }
}, 30_000)

test('a frame larger than the exempt bound trips the cap on the next frame', async () => {
  // The exemption is also bounded in size: a single ws frame can be up to the
  // relay's maxPayload (100 MiB), and exempting all of it lets a non-reading
  // viewer hold that whole frame. With the exemption capped, the ordinary
  // per-write check trips on the very next frame. On HEAD (unbounded
  // exemption) the follow-up frame is fully discounted and the viewer lives.
  process.env.RELAY_SSE_MAX_EXEMPT_BYTES = String(1 * MiB)
  const id = 'ses_exempt_bound'
  const { viewerToken, bridge } = await share(id)
  const stuck = await openViewer(viewerToken)
  stuck.pause()
  try {
    await until(() => streams.length === 1, 2000)
    expect(streams.length).toBe(1)

    // 6 MiB frame (> 1 MiB exempt bound), then one small follow-up. Only
    // 1 MiB of the 6 MiB is discounted, so the follow-up write sees ~5 MiB
    // still queued, past the 2 MiB cap, and drops the stream.
    bridge.send(JSON.stringify({ type: 'event', data: bigPartEvent(id, 6 * MiB) }))
    await until(() => streams[0].peak > 4 * MiB, 5000)
    bridge.send(JSON.stringify({ type: 'event', data: JSON.stringify({ type: 'message.part.delta', properties: { sessionID: id, delta: 'next' } }) }))

    await until(() => streams[0].res.destroyed, 5000)
    expect(streams[0].res.destroyed).toBe(true)
    expect(streams[0].peak).toBeLessThan(16 * MiB)
  } finally {
    bridge.terminate()
    stuck.destroy()
  }
}, 30_000)

test('a reading viewer still gets an oversized event whole and is never dropped by the watchdog', async () => {
  // The watchdog must only catch stalls. A viewer that keeps reading drains
  // between beats, so the exemption still does its job: the big event arrives
  // intact and the stream stays open across many heartbeats.
  const id = 'ses_exempt_reading'
  const { viewerToken, bridge } = await share(id)
  const viewer = await openViewer(viewerToken)
  const received = collect(viewer) // reads continuously
  try {
    await until(() => streams.length === 1, 2000)
    expect(streams.length).toBe(1)

    const big = bigPartEvent(id, 6 * MiB)
    bridge.send(JSON.stringify({ type: 'event', data: big }))
    await until(() => received().includes(`data: ${big}\n\n`), 10_000)
    expect(received().includes(`data: ${big}\n\n`)).toBe(true)

    // Sit through several heartbeats: a healthy viewer is not a stalled one.
    await sleep(600)
    expect(streams[0].res.destroyed).toBe(false)
    // A trailing small event still gets through.
    const tail = JSON.stringify({ type: 'message.part.delta', properties: { sessionID: id, delta: 'tail-' + 'z'.repeat(KiB) } })
    bridge.send(JSON.stringify({ type: 'event', data: tail }))
    await until(() => received().includes(`data: ${tail}\n\n`), 5000)
    expect(received().includes(`data: ${tail}\n\n`)).toBe(true)
    expect(streams[0].res.destroyed).toBe(false)
  } finally {
    bridge.terminate()
    viewer.destroy()
  }
}, 30_000)

test('a viewer reading one oversized event slower than a heartbeat still gets it whole', async () => {
  // The test above passes only because loopback takes 6 MiB in milliseconds.
  // A phone on a 1-2 Mbit/s link needs longer than a heartbeat for one big
  // frame, and the watchdog measured progress with res.writableLength alone:
  // Node lowers that only when a WHOLE socket write completes, and one frame
  // is one write, so while the frame was leaving piece by piece it read as
  // "nothing drained" and the stream was destroyed mid-frame on the second
  // beat. That event was lost, and so was every later big one.
  //
  // Here the frame takes ~3 s to read, i.e. several beats. The beat must stay
  // well above the ~300 KiB steps in which macOS loopback frees its send
  // buffer, or even a reader that is moving could look still between beats.
  process.env.RELAY_SSE_HEARTBEAT_MS = '500'
  const RATE = 4 * MiB // bytes per second the viewer reads
  const id = 'ses_exempt_slow_reader'
  const { viewerToken, bridge } = await share(id)
  const viewer = await openViewer(viewerToken)
  const received = collect(viewer)
  // Throttle: after each chunk, stop reading for as long as that chunk would
  // take at RATE, so the kernel buffers fill and the relay's write backs up.
  viewer.on('data', (chunk: Buffer) => {
    viewer.pause()
    setTimeout(() => viewer.resume(), (chunk.length / RATE) * 1000)
  })
  try {
    await until(() => streams.length === 1, 2000)
    expect(streams.length).toBe(1)

    const big = bigPartEvent(id, 12 * MiB)
    bridge.send(JSON.stringify({ type: 'event', data: big }))
    await until(() => streams[0].res.destroyed || received().includes(`data: ${big}\n\n`), 20_000)
    expect(streams[0].res.destroyed).toBe(false)
    expect(received().includes(`data: ${big}\n\n`)).toBe(true)
  } finally {
    bridge.terminate()
    viewer.destroy()
  }
}, 30_000)
