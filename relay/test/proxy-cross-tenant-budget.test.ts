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
 * The proxy's buffered-bytes budget (see proxy-buffer-cap.test.ts) was one
 * number for the whole process. It bounded memory, but not whose: registration
 * is public, so one share pointing a few non-reading sockets at its OWN bridge's
 * multi-MiB bodies filled the entire ceiling, and every OTHER share's viewer was
 * answered 503 'relay busy' until the stall watchdog cut the parked responses —
 * a window the attacker re-opened by re-dialling. A handful of idle TCP
 * connections denied service to every unrelated share, which traded the OOM the
 * budget closed for a cheap cross-tenant outage.
 *
 * So the budget is split: a share may hold an eighth of the ceiling, never less
 * than one frame, and a share that floods the proxy path only refuses itself.
 * Both halves are exercised here, with two genuinely separate shares.
 */

const MiB = 1024 * 1024

let relay: http.Server
let relayUrl: string
const saved: Record<string, string | undefined> = {}
const ENV = ['RELAY_BRIDGE_MAX_PAYLOAD_BYTES', 'RELAY_PROXY_MAX_BUFFERED_BYTES', 'ACTIVATE_FAIL_DELAY_MS']

beforeEach(async () => {
  for (const key of ENV) saved[key] = process.env[key]
  process.env.ACTIVATE_FAIL_DELAY_MS = '0'
  // 64 MiB of ceiling in eight 8 MiB frames: one share may hold 8 MiB of it.
  // Bodies are sized in MiB so a paused reader's kernel buffers cannot swallow a
  // whole one — the surplus stays queued in the relay, as under the attack.
  process.env.RELAY_BRIDGE_MAX_PAYLOAD_BYTES = String(8 * MiB)
  process.env.RELAY_PROXY_MAX_BUFFERED_BYTES = String(64 * MiB)
  const store = new Store()
  relay = http.createServer()
  const bridge = new BridgeClient(relay, store)
  relay.on('request', createApp(store, bridge))
  relay.on('close', () => bridge.close())
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve))
  relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`
})

afterEach(async () => {
  relay.closeAllConnections()
  await new Promise((resolve) => relay.close(resolve))
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

/** Register a share, join it, and attach a bridge answering `bodyBytes` bodies. */
async function shareWithBridge(id: string, bodyBytes: number) {
  const created = await request(relay).post('/api/sessions').send({ session_id: id, directory: '/work', title: 't' })
  expect(created.status).toBe(201)
  const { access_code, bridge_token } = created.body as { access_code: string; bridge_token: string }
  const act = await request(relay).post('/api/activate').send({ code: access_code, session_id: id })
  const viewerToken = viewerTokenFrom(act)
  const ws = new WebSocket(`${relayUrl.replace(/^http/, 'ws')}/bridge?session_id=${id}`, {
    headers: { 'x-bridge-token': bridge_token },
  })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const body = 'a'.repeat(bodyBytes)
  let served = 0
  ws.on('message', (raw, isBinary) => {
    if (isBinary) return
    let msg: { type?: string; request_id?: string }
    try {
      msg = JSON.parse(String(raw))
    } catch {
      return
    }
    if (msg.type === 'proxy' && typeof msg.request_id === 'string') {
      served++
      // text/plain so supertest hands back the raw body instead of JSON-parsing it.
      ws.send(JSON.stringify({ type: 'proxy_response', request_id: msg.request_id, status: 200, contentType: 'text/plain', body }))
    }
  })
  return { ws, viewerToken, served: () => served }
}

/** A raw GET that never reads its response, so the body parks in the relay. */
function stalledGet(token: string): net.Socket {
  const socket = net.connect((relay.address() as AddressInfo).port, '127.0.0.1')
  socket.on('error', () => {})
  socket.once('connect', () => {
    socket.write(`GET /agent HTTP/1.1\r\nHost: x\r\nx-viewer-token: ${token}\r\nConnection: keep-alive\r\n\r\n`)
  })
  socket.pause() // takes the response into the kernel buffer, then never reads
  return socket
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms
  while (!check() && Date.now() < deadline) await sleep(20)
}

test('a share flooding the proxy path refuses itself, not the other shares', async () => {
  // The attacker: its own registration, its own bridge, 6 MiB bodies.
  const attacker = await shareWithBridge('ses_flood_attacker', 6 * MiB)
  // An unrelated owner, whose viewer reads normally and wants a small body.
  const honest = await shareWithBridge('ses_flood_honest', 512)
  const stalled: net.Socket[] = []
  try {
    // Baseline: the honest viewer is served before anything is parked.
    const before = await request(relay).get('/agent').set('x-viewer-token', honest.viewerToken)
    expect(before.status).toBe(200)

    // Four non-reading sockets, 24 MiB of bodies: well under the 64 MiB ceiling,
    // well over the attacker's own 8 MiB slice of it.
    for (let i = 0; i < 4; i++) stalled.push(stalledGet(attacker.viewerToken))
    await until(() => attacker.served() >= 4, 5000)
    expect(attacker.served()).toBeGreaterThanOrEqual(4)
    // The bytes are charged as each body arrives, so there is nothing to wait
    // for — and the checks below must land before the stall watchdog frees them.
    await sleep(100)

    // The attacker has spent its slice: its own next request is the one refused.
    const own = await request(relay).get('/agent').set('x-viewer-token', attacker.viewerToken)
    expect(own.status).toBe(503)

    // And the unrelated share is untouched. On HEAD this was 503 'relay busy':
    // the attacker's parked bytes were charged to a single process-wide total.
    const during = await request(relay).get('/agent').set('x-viewer-token', honest.viewerToken)
    expect(during.status).toBe(200)
    expect(during.text.length).toBe(512)
  } finally {
    for (const s of stalled) s.destroy()
    attacker.ws.terminate()
    honest.ws.terminate()
  }
}, 30_000)

test('a parked response is cut soon enough to give the share its slice back', async () => {
  const attacker = await shareWithBridge('ses_flood_watchdog', 6 * MiB)
  const stalled: net.Socket[] = []
  try {
    for (let i = 0; i < 2; i++) stalled.push(stalledGet(attacker.viewerToken))
    await until(() => attacker.served() >= 2, 5000)
    await sleep(200)
    expect((await request(relay).get('/agent').set('x-viewer-token', attacker.viewerToken)).status).toBe(503)

    // Nobody touches the parked sockets: the stall watchdog alone must free the
    // budget, and soon. The hold window is how long one share's flood lasts, so
    // a re-dial every few seconds used to keep the relay refusing without a gap;
    // a few seconds of dead silence is already far more than a client that reads
    // at all needs. Checked as behaviour, not against the constants.
    let recovered = 0
    for (let i = 0; i < 12 && recovered === 0; i++) {
      await sleep(1000)
      const res = await request(relay).get('/agent').set('x-viewer-token', attacker.viewerToken)
      if (res.status === 200) recovered = i + 1
    }
    expect(recovered).toBeGreaterThan(0)
    expect(recovered).toBeLessThanOrEqual(6)
  } finally {
    for (const s of stalled) s.destroy()
    attacker.ws.terminate()
  }
}, 30_000)
