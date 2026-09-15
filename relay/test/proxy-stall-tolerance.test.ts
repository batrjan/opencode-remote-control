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
 * A viewer whose link freezes for a moment must keep its response.
 *
 * sendBounded watches a buffered proxy response and cuts one that moves no
 * bytes, so a socket that never reads stops pinning the buffered-bytes budget.
 * The window was briefly one 2.5 s strike, on the reasoning that a share
 * re-opening dead sockets could otherwise hold the budget full continuously.
 * That reasoning predates the per-share slice: a hostile share now fills only
 * its own eighth of the ceiling, so the blast radius is bounded without cutting
 * anyone quickly — and the viewers this project exists for (an owner uplink
 * measured at 0.74 Mbit/s, phones and tablets on mobile data) do freeze for
 * seconds at a time on a cell handover, in a tunnel, or with the screen off.
 * One strike turned those into a failed request; the tolerance is back to ~10 s.
 *
 * Not covered here, because it is not what this window decides: a body big
 * enough to be handed off to the socket in one go leaves res.writableLength at
 * 0, which the watchdog reads as "done" and never strikes against, so a socket
 * that reads NOTHING keeps its charge until it closes. The per-share slice is
 * what bounds that, not the watchdog; measured on this host, a 48 MiB body to a
 * paused socket was still charged after 20 s.
 */

const MiB = 1024 * 1024
// Big enough that a paused reader's kernel buffers (autotuned into the
// megabytes on this host) cannot swallow the whole body: the surplus has to
// stay queued in the relay, which is the only state the watchdog can see.
const BODY_BYTES = 48 * MiB

let relay: http.Server
let relayUrl: string
const saved: Record<string, string | undefined> = {}
const ENV = [
  'RELAY_PROXY_STALL_CHECK_MS',
  'RELAY_PROXY_STALL_STRIKES',
  'RELAY_BRIDGE_MAX_PAYLOAD_BYTES',
  'RELAY_PROXY_MAX_BUFFERED_BYTES',
  'ACTIVATE_FAIL_DELAY_MS',
]

beforeEach(async () => {
  for (const key of ENV) saved[key] = process.env[key]
  process.env.ACTIVATE_FAIL_DELAY_MS = '0'
  // The real window is seconds; scaled down here so the test costs a moment.
  // Strikes are left at their default: this test is about how many no-progress
  // checks are tolerated, so hard-coding that number here would prove nothing.
  process.env.RELAY_PROXY_STALL_CHECK_MS = '150'
  process.env.RELAY_BRIDGE_MAX_PAYLOAD_BYTES = String(64 * MiB)
  process.env.RELAY_PROXY_MAX_BUFFERED_BYTES = String(512 * MiB)
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

async function share(id: string) {
  const created = await request(relay).post('/api/sessions').send({ session_id: id, directory: '/work', title: 't' })
  expect(created.status).toBe(201)
  const { access_code, bridge_token } = created.body as { access_code: string; bridge_token: string }
  const act = await request(relay).post('/api/activate').send({ code: access_code, session_id: id })
  return { viewerToken: viewerTokenFrom(act), bridgeToken: bridge_token }
}

/** A bridge that answers every proxy request with a body too big to fit a socket buffer. */
async function mockBridge(id: string, token: string) {
  const ws = new WebSocket(`${relayUrl.replace(/^http/, 'ws')}/bridge?session_id=${id}`, {
    headers: { 'x-bridge-token': token },
  })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const body = 'a'.repeat(BODY_BYTES)
  ws.on('message', (raw, isBinary) => {
    if (isBinary) return
    let msg: { type?: string; request_id?: string }
    try {
      msg = JSON.parse(String(raw))
    } catch {
      return
    }
    if (msg.type === 'proxy' && typeof msg.request_id === 'string') {
      ws.send(JSON.stringify({ type: 'proxy_response', request_id: msg.request_id, status: 200, contentType: 'text/plain', body }))
    }
  })
  return ws
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Issue a GET on a raw socket that reads nothing for `freezeMs`, then reads to
 * the end. Resolves with the bytes of body received and whether the relay cut
 * the connection before the body was whole.
 */
function frozenThenReadingGet(token: string, path: string, freezeMs: number) {
  return new Promise<{ bodyBytes: number; cut: boolean }>((resolve) => {
    const socket = net.connect((relay.address() as AddressInfo).port, '127.0.0.1')
    let raw = Buffer.alloc(0)
    let headerEnd = -1
    let settled = false
    const finish = (cut: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve({ bodyBytes: headerEnd < 0 ? 0 : raw.length - headerEnd, cut })
    }
    socket.on('error', () => finish(true))
    socket.on('close', () => finish(true))
    socket.on('data', (chunk) => {
      raw = Buffer.concat([raw, chunk])
      if (headerEnd < 0) {
        const at = raw.indexOf('\r\n\r\n')
        if (at >= 0) headerEnd = at + 4
      }
      if (headerEnd >= 0 && raw.length - headerEnd >= BODY_BYTES) finish(false)
    })
    socket.once('connect', () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nx-viewer-token: ${token}\r\nConnection: close\r\n\r\n`)
      // Paused: the kernel buffer takes what it can and the rest stays queued in
      // the relay, which is the only state the stall watchdog looks at.
      socket.pause()
      setTimeout(() => socket.resume(), freezeMs)
    })
  })
}

test('a viewer that freezes for several checks and then reads still gets its whole body', async () => {
  const id = 'ses_freeze'
  const { viewerToken, bridgeToken } = await share(id)
  const bridge = await mockBridge(id, bridgeToken)
  try {
    // Frozen across two no-progress checks (2 x 150 ms) before reading again —
    // a single-strike watchdog destroys the response inside this window.
    const { bodyBytes, cut } = await frozenThenReadingGet(viewerToken, '/agent', 400)
    expect(cut, 'the relay kept the response open through the freeze').toBe(false)
    expect(bodyBytes).toBe(BODY_BYTES)
  } finally {
    bridge.terminate()
  }
}, 40_000)

test('one strike is what broke those viewers: the same freeze loses the body', async () => {
  // The state this fix came from, asserted directly rather than described — so
  // this file fails if the tolerance is ever narrowed back to a single check.
  process.env.RELAY_PROXY_STALL_STRIKES = '1'
  const id = 'ses_onestrike'
  const { viewerToken, bridgeToken } = await share(id)
  const bridge = await mockBridge(id, bridgeToken)
  try {
    const { bodyBytes } = await frozenThenReadingGet(viewerToken, '/agent', 400)
    expect(bodyBytes, 'a single strike cuts the frozen viewer mid-body').toBeLessThan(BODY_BYTES)
  } finally {
    bridge.terminate()
  }
}, 40_000)
