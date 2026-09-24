import { afterEach, beforeEach, expect, test } from 'vitest'
import type { Server } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import request from 'supertest'
import { WebSocket } from 'ws'
import { startServer } from '../src/server'

/**
 * The relay's half of "a slow link is not a dead link".
 *
 * The bridge answers the relay's ping on the same socket it sends everything
 * else on. On the owner's saturated home uplink that pong waits behind
 * megabytes of transcript, so it reaches the relay late or not before the
 * grace runs out — and the relay dropped a bridge that was delivering data the
 * entire time, failing every viewer request in flight. Any bytes arriving from
 * the bridge prove it is reachable just as well as a pong does.
 */

const API_KEY = 'test-relay-key'
process.env.RELAY_API_KEY = API_KEY
process.env.RELAY_WS_PING_INTERVAL_MS = '60'
process.env.RELAY_WS_PONG_GRACE_ROUNDS = '1'

let relay: Server
let relayUrl: string

beforeEach(async () => {
  relay = await startServer(0)
  relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`
})

afterEach(async () => {
  relay.closeAllConnections()
  await new Promise((resolve) => relay.close(resolve))
})

async function silentBridge(session_id: string) {
  const created = await request(relay)
    .post('/api/sessions')
    .set('x-api-key', API_KEY)
    .send({ session_id, directory: '/path', title: 'busy' })
  expect(created.status).toBe(201)
  const ws = new WebSocket(`${relayUrl.replace(/^http/, 'ws')}/bridge?session_id=${session_id}`, {
    headers: { 'x-bridge-token': created.body.bridge_token },
  })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  // Our pongs never arrive — the saturated-uplink condition. (`ws` auto-pongs,
  // so the silence has to be forced.)
  ws.pong = () => {}
  let closed = false
  ws.once('close', () => {
    closed = true
  })
  return { ws, isClosed: () => closed }
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('a bridge that keeps sending is not dropped for late pongs', async () => {
  const { ws, isClosed } = await silentBridge('ses_busy_msgs')
  const t = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: 'event', data: '{}' })), 20)
  try {
    await settle(60 * 10) // ten ping rounds against a grace of one
    expect(isClosed()).toBe(false)
  } finally {
    clearInterval(t)
    ws.terminate()
  }
}, 10_000)

test('bytes of a frame still in transit count, before the frame is complete', async () => {
  // One large frame dribbling in over a slow link: no message event can fire
  // until the last byte, and no pong can overtake it — only raw bytes show
  // the bridge is there. Built by hand so it can be sent slowly.
  const { ws, isClosed } = await silentBridge('ses_busy_frame')
  const raw = (ws as unknown as { _socket: Socket })._socket
  const payload = Buffer.from(JSON.stringify({ type: 'event', data: 'x'.repeat(4000) }))
  const header = Buffer.alloc(2 + 2 + 4) // FIN|text, MASK|126, 16-bit length, zero mask key
  header[0] = 0x81
  header[1] = 0x80 | 126
  header.writeUInt16BE(payload.length, 2)
  const frame = Buffer.concat([header, payload]) // a zero key masks to the identity
  try {
    const chunk = Math.ceil(frame.length / 40)
    for (let off = 0; off < frame.length && !isClosed(); off += chunk) {
      raw.write(frame.subarray(off, off + chunk))
      await settle(20) // 40 chunks × 20 ms ≈ 13 ping rounds for one frame
    }
    expect(isClosed()).toBe(false)
  } finally {
    ws.terminate()
  }
}, 10_000)

test('a bridge that goes quiet is still dropped', async () => {
  const { isClosed, ws } = await silentBridge('ses_quiet')
  try {
    const deadline = Date.now() + 3000
    while (!isClosed() && Date.now() < deadline) await settle(20)
    expect(isClosed()).toBe(true)
  } finally {
    ws.terminate()
  }
}, 10_000)
