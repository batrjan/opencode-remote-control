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
 * The proxy path buffered a full response body in the relay heap with NO
 * cumulative cap, unlike the SSE fan-out. A public registrant whose own bridge
 * returned multi-MiB bodies to slow / non-reading GET sockets grew the heap by
 * the full body per socket until the relay OOM'd, downing every share (see the
 * security run's verify-1/dos.mjs). Two bounds, both exercised here:
 *
 *  - maxPayload on the bridge WebSocketServer: a single frame larger than it is
 *    rejected before it can be buffered at all;
 *  - a process-wide ceiling on bytes the proxy path holds buffered across every
 *    in-flight response: over it, a new proxy request is answered 503 rather
 *    than parked, so concurrent slow readers cannot exhaust memory.
 */

const MiB = 1024 * 1024

let relay: http.Server
let relayUrl: string
const saved: Record<string, string | undefined> = {}
const ENV = ['RELAY_BRIDGE_MAX_PAYLOAD_BYTES', 'RELAY_PROXY_MAX_BUFFERED_BYTES', 'RELAY_BRIDGE_RECONNECT_WAIT_MS', 'ACTIVATE_FAIL_DELAY_MS']

beforeEach(async () => {
  for (const key of ENV) saved[key] = process.env[key]
  process.env.ACTIVATE_FAIL_DELAY_MS = '0'
  // A frame over 8 MiB is rejected; the proxy path holds at most ~8 MiB buffered.
  // Bodies are sized in MiB so a paused reader's kernel buffers cannot absorb a
  // whole one — the surplus stays queued in the relay, exactly as under the DoS.
  process.env.RELAY_BRIDGE_MAX_PAYLOAD_BYTES = String(8 * MiB)
  process.env.RELAY_PROXY_MAX_BUFFERED_BYTES = String(8 * MiB)
  // A dropped bridge fails its in-flight GETs fast, instead of the 5 s default.
  process.env.RELAY_BRIDGE_RECONNECT_WAIT_MS = '200'
  const store = new Store()
  relay = http.createServer()
  // maxPayload is read when the bridge server is constructed, so the env above
  // must already be set — mirrors how the relay reads it once at startup.
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

/** Register a share and join it once; returns the tokens. */
async function share(id: string) {
  const created = await request(relay).post('/api/sessions').send({ session_id: id, directory: '/work', title: 't' })
  expect(created.status).toBe(201)
  const { access_code, bridge_token } = created.body as { access_code: string; bridge_token: string }
  const act = await request(relay).post('/api/activate').send({ code: access_code, session_id: id })
  return { viewerToken: viewerTokenFrom(act), bridgeToken: bridge_token }
}

/**
 * A mock bridge that answers every proxy request with a plain (uncompressed)
 * proxy_response of `bodyBytes` bytes. Registration is public, so this is the
 * hostile-bridge shape the DoS used.
 */
async function mockBridge(id: string, token: string, bodyBytes: number) {
  const ws = new WebSocket(`${relayUrl.replace(/^http/, 'ws')}/bridge?session_id=${id}`, {
    headers: { 'x-bridge-token': token },
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
      // text/plain so supertest returns the raw body instead of JSON-parsing it.
      ws.send(JSON.stringify({ type: 'proxy_response', request_id: msg.request_id, status: 200, contentType: 'text/plain', body }))
    }
  })
  return { ws, served: () => served }
}

/** A raw GET that never reads its response, so the body parks in the relay. */
function stalledGet(token: string, path: string): net.Socket {
  const socket = net.connect((relay.address() as AddressInfo).port, '127.0.0.1')
  socket.on('error', () => {})
  socket.once('connect', () => {
    socket.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nx-viewer-token: ${token}\r\nConnection: keep-alive\r\n\r\n`)
  })
  socket.pause() // takes the response into the kernel buffer, then never reads
  return socket
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms
  while (!check() && Date.now() < deadline) await sleep(20)
}

test('a bridge frame larger than maxPayload is rejected, and the relay stays up', async () => {
  const id = 'ses_maxpayload'
  const { viewerToken, bridgeToken } = await share(id)
  // The bridge answers with a 12 MiB body — past the 8 MiB maxPayload.
  const bridge = await mockBridge(id, bridgeToken, 12 * MiB)
  try {
    const res = await request(relay).get('/agent').set('x-viewer-token', viewerToken)
    // The over-sized frame never reaches the pending table: ws raises an error
    // on the socket, the relay terminates it, and the in-flight GET fails. On
    // HEAD (no maxPayload) the frame is accepted and this is a 200.
    expect(res.status).not.toBe(200)
    expect(res.status).toBeGreaterThanOrEqual(500)
    // The relay itself is unharmed — the violation was confined to its socket.
    expect((await request(relay).get('/health')).status).toBe(200)
  } finally {
    bridge.ws.terminate()
  }
}, 20_000)

test('the aggregate ceiling caps concurrent slow readers and refuses new bodies with 503', async () => {
  const id = 'ses_ceiling'
  const { viewerToken, bridgeToken } = await share(id)
  // Each body is 6 MiB — under maxPayload, so it is delivered, but one parked in
  // a non-reading socket already holds 6 MiB, and a second would push the total
  // past the 8 MiB ceiling.
  const bridge = await mockBridge(id, bridgeToken, 6 * MiB)
  const stalled: net.Socket[] = []
  try {
    // Two non-reading GETs: the first parks (6 MiB), the second is already over
    // the ceiling. The parked body pins the budget for as long as it is unread.
    for (let i = 0; i < 2; i++) stalled.push(stalledGet(viewerToken, '/agent'))
    await until(() => bridge.served() >= 2, 5000)
    expect(bridge.served()).toBeGreaterThanOrEqual(2)
    await sleep(200) // let the relay finish buffering the parked response

    // An honest reader now finds the budget full: its 6 MiB body would push the
    // total past the ceiling, so it is refused rather than buffered. On HEAD (no
    // ceiling) this is a 200 carrying the full body.
    const busy = await request(relay).get('/agent').set('x-viewer-token', viewerToken)
    expect(busy.status).toBe(503)
    // The relay is still serving, not crashed.
    expect((await request(relay).get('/health')).status).toBe(200)

    // Room comes back once the parked readers are gone: their budget is released
    // when the relay sees each response close, and an honest reader is served the
    // whole body again.
    for (const s of stalled) s.destroy()
    await sleep(300) // let the relay observe the closes and free the budget
    const ok = await request(relay).get('/agent').set('x-viewer-token', viewerToken)
    expect(ok.status).toBe(200)
    expect(ok.text.length).toBe(6 * MiB)
  } finally {
    for (const s of stalled) s.destroy()
    bridge.ws.terminate()
  }
}, 20_000)
