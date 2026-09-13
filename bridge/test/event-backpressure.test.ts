import { afterEach, beforeEach, expect, test } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import { opencodeAuthHeader } from '../src/config'
import { OpencodeClient } from '../src/opencode'
import { RelayWSClient } from '../src/relay'

/**
 * Events must not pile up without bound behind a slow uplink.
 *
 * opencode emits events as fast as the model writes; the owner's uplink
 * carries what it carries. Everything in between used to queue in the bridge
 * with no limit (4.5 MB measured in the field), and every answer to a viewer's
 * request queued behind it. Forwarding now stops reading opencode's stream
 * while the relay socket is backed up — and loses nothing by doing so.
 */

const HIGH_WATER = 256 * 1024
process.env.REMOTE_CONTROL_EVENT_HIGH_WATER_BYTES = String(HIGH_WATER)
process.env.REMOTE_CONTROL_WS_PING_INTERVAL_MS = '10000'

const EVENTS = 400
const EVENT_BYTES = 32 * 1024

let opencode: Server
let opencodeUrl: string

beforeEach(async () => {
  opencode = createServer(async (req, res) => {
    if (req.headers.authorization !== opencodeAuthHeader()) {
      res.writeHead(401).end()
      return
    }
    if (!req.url?.startsWith('/event')) {
      res.writeHead(404).end()
      return
    }
    // A producer limited only by how fast the bridge reads.
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const pad = 'x'.repeat(EVENT_BYTES)
    for (let n = 0; n < EVENTS; n++) {
      if (!res.write(`data: ${JSON.stringify({ type: 'message.part.delta', n, pad })}\n\n`)) {
        await new Promise((resolve) => res.once('drain', resolve))
      }
    }
  })
  await new Promise<void>((resolve) => opencode.listen(0, '127.0.0.1', resolve))
  opencodeUrl = `http://127.0.0.1:${(opencode.address() as AddressInfo).port}`
})

afterEach(async () => {
  opencode.closeAllConnections()
  await new Promise((resolve) => opencode.close(resolve))
})

test('a backed-up relay socket pauses event forwarding, and every event still arrives in order', async () => {
  const wss = new WebSocketServer({ port: 0, path: '/bridge' })
  await new Promise<void>((resolve) => wss.once('listening', resolve))
  const received: number[] = []
  let resume: () => void = () => {}
  wss.on('connection', (socket, req) => {
    // The slow uplink: the relay takes nothing for a while.
    req.socket.pause()
    resume = () => req.socket.resume()
    socket.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as { type: string; data: string }
      if (msg.type === 'event') received.push((JSON.parse(msg.data) as { n: number }).n)
    })
  })
  const ws = new RelayWSClient(
    `http://127.0.0.1:${(wss.address() as AddressInfo).port}`,
    new OpencodeClient(opencodeUrl, 'opencode', process.env.OPENCODE_SERVER_PASSWORD ?? ''),
  )
  const socket = () => (ws as unknown as { ws: import('ws').WebSocket }).ws
  try {
    await ws.connect('sess-backpressure', 'token')
    await ws.startEventForwarding()

    // ~12.8 MB of events on offer, far beyond what the OS buffers absorb.
    let maxQueued = 0
    const until = Date.now() + 800
    while (Date.now() < until) {
      maxQueued = Math.max(maxQueued, socket().bufferedAmount)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    // Bounded by the mark plus the one read that was already in hand.
    expect(maxQueued).toBeGreaterThan(0)
    expect(maxQueued).toBeLessThan(HIGH_WATER + 512 * 1024)

    resume()
    const deadline = Date.now() + 10_000
    while (received.length < EVENTS && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(received.length).toBe(EVENTS)
    expect(received).toEqual(Array.from({ length: EVENTS }, (_, i) => i))
  } finally {
    ws.close()
    wss.close()
  }
}, 20_000)
