import { afterEach, beforeEach, expect, test } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import { WebSocket } from 'ws'
import { createApp } from '../src/server'
import { Store } from '../src/store'
import { BridgeClient } from '../src/ws/bridge'

/**
 * A viewer that stops reading must not make the relay buffer its events without
 * bound.
 *
 * The SSE fan-out wrote every bridge event to every viewer response and ignored
 * whether the viewer was keeping up. Its only guards noticed a response that
 * was already closed, never one whose peer had simply stopped reading — a phone
 * that lost signal, a laptop lid shut mid-stream, a tab frozen in the
 * background. Behind nginx with proxy_buffering off such a viewer pushes back
 * straight onto the relay, and Node kept every unsent event in the response's
 * userland write buffer. Measured: one stuck viewer held ~50 MB after three
 * seconds of model output, a viewer trickling at ~64 KB/s grew by megabytes and
 * never closed, and 64 stuck streams on ONE viewer token (the per-session
 * stream cap counts streams, not bytes) took the real relay to a heap-limit OOM
 * in seconds — every share on it went down with that one viewer.
 */

process.env.ACTIVATE_FAIL_DELAY_MS = '0'

/**
 * What "bounded" means here: a few megabytes per stream, whatever the relay's
 * exact cap is. The unfixed relay blew past it within the first second.
 */
const BOUND = 8 * 1024 * 1024

let relay: http.Server
let relayUrl: string
/** Relay-side responses of every viewer event stream, in arrival order. */
let streams: { res: http.ServerResponse; peak: number }[]

beforeEach(async () => {
  streams = []
  const store = new Store()
  relay = http.createServer()
  const bridge = new BridgeClient(relay, store)
  // Registered before the app so it sees each response first: record the
  // largest backlog the relay ever held for that viewer, right after each
  // write and before anything the relay does about it.
  relay.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
    if (req.url !== '/event') return
    const entry = { res, peak: 0 }
    streams.push(entry)
    const write = res.write.bind(res) as (...args: unknown[]) => boolean
    res.write = ((...args: unknown[]) => {
      const ok = write(...args)
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
})

/** Register a share, join it once, and connect its bridge. */
async function share(id: string) {
  const created = await request(relay).post('/api/sessions').send({ session_id: id, directory: '/work', title: 't' })
  expect(created.status).toBe(201)
  const { access_code, bridge_token } = created.body as { access_code: string; bridge_token: string }
  const act = await request(relay).post('/api/activate').send({ code: access_code, session_id: id })
  const viewerToken = act.body.viewer_token as string
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A model streaming large deltas: `count` events of ~64 KB, paced in batches. */
async function flood(bridge: WebSocket, id: string, count: number): Promise<number> {
  const event = JSON.stringify({ type: 'message.part.delta', properties: { sessionID: id, delta: 'x'.repeat(64 * 1024) } })
  let sent = 0
  for (let i = 0; i < count; i++) {
    bridge.send(JSON.stringify({ type: 'event', data: event }))
    sent += event.length
    if (i % 16 === 15) await sleep(20)
  }
  return sent
}

async function until(check: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms
  while (!check() && Date.now() < deadline) await sleep(20)
}

test('a viewer that stops reading is dropped at a bounded backlog; a healthy one keeps streaming', async () => {
  const id = 'ses_backpressure'
  const { viewerToken, bridge } = await share(id)
  const stuck = await openViewer(viewerToken)
  stuck.pause() // never reads again, never hangs up
  const healthy = await openViewer(viewerToken)
  let healthyBytes = 0
  healthy.on('data', (chunk: Buffer) => (healthyBytes += chunk.length))
  try {
    await until(() => streams.length === 2, 2000)
    expect(streams.length).toBe(2)
    const [stuckStream, healthyStream] = streams

    // ~50 MB of output: far past any sane per-viewer allowance.
    const sent = await flood(bridge, id, 800)
    await until(() => healthyBytes >= sent, 10_000)

    // The stuck viewer never held more than a few MB, and was cut loose rather
    // than parked: a destroyed response frees what was queued for it.
    expect(stuckStream.peak).toBeLessThan(BOUND)
    expect(stuckStream.res.destroyed).toBe(true)
    // The healthy viewer on the same share got every event and stays open.
    expect(healthyBytes).toBeGreaterThanOrEqual(sent)
    expect(healthyStream.res.destroyed).toBe(false)
    expect(healthyStream.peak).toBeLessThan(BOUND)
  } finally {
    bridge.terminate()
    stuck.destroy()
    healthy.destroy()
  }
}, 30_000)

test('64 stuck streams on one viewer token stay bounded and give their slots back', async () => {
  const id = 'ses_backpressure_many'
  const { viewerToken, bridge } = await share(id)
  const sockets: net.Socket[] = []
  try {
    // One token may hold every stream slot of the session.
    for (let i = 0; i < 64; i++) {
      const socket = await openViewer(viewerToken)
      socket.pause()
      sockets.push(socket)
    }
    await until(() => streams.length === 64, 5000)
    expect(streams.length).toBe(64)

    await flood(bridge, id, 200) // ~13 MB, fanned out 64 times
    await until(() => streams.every((s) => s.res.destroyed), 10_000)

    // Unfixed, 64 copies of the output piled up in the relay (~830 MB here).
    for (const s of streams) expect(s.peak).toBeLessThan(BOUND)
    expect(streams.every((s) => s.res.destroyed)).toBe(true)

    // The dropped streams released their slots: a fresh viewer stream opens
    // instead of being refused with 429 by streams nobody is reading.
    const again = await openViewer(viewerToken)
    sockets.push(again)
    const status = await new Promise<string>((resolve) =>
      again.once('data', (chunk: Buffer) => resolve(chunk.toString('latin1').split('\r\n')[0])),
    )
    expect(status).toBe('HTTP/1.1 200 OK')
  } finally {
    bridge.terminate()
    for (const socket of sockets) socket.destroy()
  }
}, 60_000)
