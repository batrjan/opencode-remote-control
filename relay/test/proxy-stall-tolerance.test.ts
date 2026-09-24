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
import { proxyStallStrikes } from '../src/config'
import { stallChecker, type StallWatched } from '../src/proxy/adapter'

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
 * Two tests, because the two halves of that claim need different instruments.
 *
 * How many silent checks are tolerated is asserted on the rule itself
 * (stallChecker), a window at a time, with nothing draining. It cannot be
 * asserted through a socket: a viewer that stops reading does NOT stop the
 * bytes. Measured here with the watchdog instrumented, a 48 MiB body to a
 * socket paused for 400 ms was still being handed to the kernel throughout —
 * the receive buffer autotunes into the megabytes — and the request/response
 * round trip through the bridge takes ~530 ms anyway, so the pause was over
 * before res.send() ran, every time. What the watchdog then saw was an ordinary
 * slow drain, with res.writableLength pinned at the whole body (one large write
 * reports nothing until it completes) and libuv's queue falling in fixed ~1.1
 * MiB steps. Two consecutive checks reading the SAME step is a sampling
 * coincidence: it happened 0.8-2.7 s into the drain on this host in 6 runs out
 * of 6, and never on a GitHub runner, where the same body drains about three
 * times faster. That is what made the single-strike control here fail twice on
 * CI while passing locally — it was measuring the host, not the tolerance.
 *
 * What the end-to-end test does prove is the outcome that matters and that only
 * the real relay can show: a 48 MiB body to a reader this slow arrives whole,
 * through a real socket, a real bridge frame and the real budget accounting.
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
    // The freeze is what a phone does; it is not what the relay sees, and the
    // header explains why (the kernel keeps taking bytes, and the bridge round
    // trip outlasts the pause). What this asserts is the outcome: 48 MiB, a
    // reader slow enough that the relay's queue is still full a dozen checks
    // later, and the whole body delivered rather than a response cut mid-flight.
    // How many silent checks that survives is the next test's job.
    const { bodyBytes, cut } = await frozenThenReadingGet(viewerToken, '/agent', 400)
    expect(cut, 'the relay kept the response open through the freeze').toBe(false)
    expect(bodyBytes).toBe(BODY_BYTES)
  } finally {
    bridge.terminate()
  }
}, 40_000)

/**
 * A response whose backlog provably does not move: nothing drains, so every
 * check below is a silent one and the count is the tolerance itself. This is
 * the state the watchdog exists to reclaim, and the one no real socket will
 * hold still in for a test (see the header, and stallChecker).
 */
class FrozenResponse implements StallWatched {
  writableFinished = false
  writableLength = BODY_BYTES
  destroyed = false
  destroy(): void {
    this.destroyed = true
  }
}

/** libuv's queue for a socket that is taking nothing: the same number forever. */
const QUEUED = 8 * MiB
const noop = () => {}

test('one strike is what broke those viewers: the first silent check must not cut', () => {
  // The state this fix came from, asserted directly rather than described — so
  // this file fails if the tolerance is ever narrowed back to a single check,
  // on any machine, whatever that machine's sockets buffer. Each call to
  // check() is one window in which no byte moved.
  const onStrike = new FrozenResponse()
  stallChecker(onStrike, () => QUEUED, () => 1, noop)()
  expect(onStrike.destroyed, 'one strike cuts the frozen viewer at its first silent check').toBe(true)

  const shipped = proxyStallStrikes()
  const patient = new FrozenResponse()
  const check = stallChecker(patient, () => QUEUED, proxyStallStrikes, noop)
  check()
  expect(patient.destroyed, `cut at the first of ${shipped} silent checks`).toBe(false)
  for (let window = 2; window < shipped; window++) {
    check()
    expect(patient.destroyed, `cut after ${window} of ${shipped} silent checks`).toBe(false)
  }
  check()
  expect(patient.destroyed, 'never cut, however long the silence').toBe(true)
})

test('a viewer that moves any bytes at all keeps its response, however slowly it reads', () => {
  // The other half of the same rule, and the reason it counts bytes rather than
  // seconds: an owner uplink at 0.74 Mbit/s is not a stalled socket. One byte a
  // window is enough, for as many windows as it takes.
  const slow = new FrozenResponse()
  let queued = QUEUED
  const trickle = stallChecker(slow, () => queued, proxyStallStrikes, noop)
  for (let window = 0; window < proxyStallStrikes() * 4; window++) {
    queued -= 1
    trickle()
  }
  expect(slow.destroyed, 'a reader moving one byte a window was cut').toBe(false)

  // And a silence that ends short of the tolerance costs nothing afterwards:
  // the count starts over, which is what the end-to-end freeze above relies on.
  const stuttering = new FrozenResponse()
  let stutterQueued = QUEUED
  const stutter = stallChecker(stuttering, () => stutterQueued, proxyStallStrikes, noop)
  for (let round = 0; round < 3; round++) {
    for (let window = 1; window < proxyStallStrikes(); window++) stutter()
    stutterQueued -= 1
    stutter()
  }
  expect(stuttering.destroyed, 'repeated near-miss silences accumulated into a cut').toBe(false)
})
