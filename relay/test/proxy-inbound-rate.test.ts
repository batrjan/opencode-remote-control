import { afterEach, beforeEach, expect, test } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { createApp } from '../src/server'
import { Store } from '../src/store'
import { BridgeClient } from '../src/ws/bridge'
import { proxyInboundMinRateBytes, proxyStallCheckMs, proxyStallStrikes } from '../src/config'

/**
 * Progress on an arriving body is a RATE, not a pulse.
 *
 * proxy-inbound-stall.test.ts pins the two ends of the old rule: a body that
 * moves no byte at all is cut, a body that is arriving is not. Between them sat
 * the whole attack it was written against — the watchdog asked only whether
 * bytes had moved since the last check, so ONE byte per check (0.4 bytes a
 * second at the shipped 2.5 s window) kept a maximal claim alive for as long as
 * Node's own requestTimeout allowed, which the relay never set. Sixteen such
 * sockets held the entire non-quiet ceiling for the price of seven bytes.
 *
 * The tolerance that makes the watchdog generous protects a client on the
 * project's own uplink (~92 KiB/s), not one byte a tick; these tests hold both
 * ends at once — a drip is cut, a slow-but-real upload is not.
 */

const KiB = 1024
const BODY_LIMIT = 64 * KiB

const ENV = [
  'RELAY_PROXY_MAX_INBOUND_BYTES',
  'RELAY_PROXY_BODY_LIMIT_BYTES',
  'RELAY_PROXY_STALL_CHECK_MS',
  'RELAY_PROXY_STALL_STRIKES',
  'RELAY_PROMPT_TIMEOUT_MS',
  'ACTIVATE_FAIL_DELAY_MS',
]
const saved: Record<string, string | undefined> = {}

let server: http.Server
let store: Store
let bridge: BridgeClient
let base: string
let port: number
const sockets: WebSocket[] = []
const raw: net.Socket[] = []
const aborts: AbortController[] = []

beforeEach(async () => {
  for (const key of ENV) saved[key] = process.env[key]
  process.env.ACTIVATE_FAIL_DELAY_MS = '0'
  process.env.RELAY_PROMPT_TIMEOUT_MS = '15000'
  process.env.RELAY_PROXY_BODY_LIMIT_BYTES = String(BODY_LIMIT)
  process.env.RELAY_PROXY_MAX_INBOUND_BYTES = String(8 * BODY_LIMIT)
  // A tenth of the shipped tolerance, as in proxy-inbound-stall.test.ts, so the
  // run is seconds rather than ten of them.
  process.env.RELAY_PROXY_STALL_CHECK_MS = '200'
  process.env.RELAY_PROXY_STALL_STRIKES = '2'
  store = new Store()
  server = http.createServer()
  bridge = new BridgeClient(server, store)
  server.on('request', createApp(store, bridge))
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as AddressInfo).port
      base = `127.0.0.1:${port}`
      resolve()
    }),
  )
})

afterEach(async () => {
  for (const ac of aborts.splice(0)) ac.abort()
  for (const socket of raw.splice(0)) socket.destroy()
  for (const ws of sockets.splice(0)) ws.terminate()
  bridge.close()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A registered share whose "bridge" is connected but answers nothing. */
async function silentShare(session_id: string, ip: string) {
  const res = await fetch(`http://${base}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({ session_id, directory: '/w', title: 't' }),
  })
  expect(res.status).toBe(201)
  const { access_code, bridge_token } = (await res.json()) as { access_code: string; bridge_token: string }
  const ws = new WebSocket(`ws://${base}/bridge?session_id=${encodeURIComponent(session_id)}`, {
    headers: { 'x-bridge-token': bridge_token },
  })
  sockets.push(ws)
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  const { viewer_token } = store.activate(access_code, session_id)
  return { viewer_token: viewer_token as string }
}

/** One prompt of `bytes`, tracked: `settled` stays undefined while it is held. */
function prompt(session_id: string, viewer_token: string, bytes: number) {
  const ac = new AbortController()
  aborts.push(ac)
  const skeleton = JSON.stringify({ messageID: 'msg_x', parts: [{ type: 'text', text: '' }] })
  const body = JSON.stringify({
    messageID: 'msg_x',
    parts: [{ type: 'text', text: 'a'.repeat(Math.max(bytes - skeleton.length, 1)) }],
  })
  const tracked: { settled?: number } = {}
  void fetch(`http://${base}/session/${session_id}/prompt_async`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-viewer-token': viewer_token },
    body,
    signal: ac.signal,
  })
    .then((res) => {
      tracked.settled = res.status
      return res.text()
    })
    .catch(() => {
      tracked.settled = 0
    })
  return tracked
}

/** A socket that declares a maximal body and then writes `each` bytes every `everyMs`. */
function declareBodyAndWrite(session_id: string, viewer_token: string, each: number, everyMs: number) {
  const socket = net.connect(port, '127.0.0.1')
  raw.push(socket)
  const seen: Buffer[] = []
  let sent = 0
  socket.on('error', () => {})
  socket.on('data', (chunk: Buffer) => seen.push(chunk))
  const head = '{"messageID":"msg_x","parts":[{"type":"text","text":"'
  socket.on('connect', () => {
    socket.write(
      `POST /session/${session_id}/prompt_async HTTP/1.1\r\n` +
        `Host: ${base}\r\n` +
        `Content-Type: application/json\r\n` +
        `Content-Length: ${BODY_LIMIT}\r\n` +
        `x-viewer-token: ${viewer_token}\r\n\r\n` +
        head,
    )
    const timer = setInterval(() => {
      if (socket.destroyed) return clearInterval(timer)
      socket.write('a'.repeat(each))
      sent += each
    }, everyMs)
    timer.unref?.()
    socket.on('close', () => clearInterval(timer))
  })
  return { answer: () => Buffer.concat(seen).toString('latin1').split('\r\n')[0], sent: () => sent }
}

test('a body that only drips is cut like one that stopped', async () => {
  const { viewer_token } = await silentShare('ses_rate1', '203.0.113.51')
  // One byte per check window. Under the old rule this was progress, and a
  // maximal charge rode on it indefinitely.
  const drip = declareBodyAndWrite('ses_rate1', viewer_token, 1, 250)
  await sleep(3_000)
  console.log(`drip: answer=${JSON.stringify(drip.answer())} bytes sent=${drip.sent()}`)
  expect(drip.answer()).toContain('408')

  // And the charge it was holding is back: the share's slice is free.
  const after = prompt('ses_rate1', viewer_token, BODY_LIMIT)
  await sleep(400)
  console.log(`drip: after the cut, a full-size body = ${String(after.settled)}`)
  expect(after.settled).toBeUndefined()
}, 30_000)

/**
 * A window that pays does not wipe out the windows that did not.
 *
 * The strikes were reset by ONE paid window, so what the rule actually enforced
 * was the floor divided by the strike count — a quarter of it at the shipped
 * four. A sawtooth of one window's worth of bytes once per whole tolerance
 * (1166 B/s against a documented ~4.3 KiB/s) held a full 25 MiB claim for as
 * long as it was watched, while an honest steady client under the floor was cut
 * in ten seconds. So a window's shortfall is carried as a DEBT instead: it is
 * paid off by whatever the next windows move, and only a debt of the whole
 * tolerance is cut. Complete silence still costs exactly proxyStallStrikes()
 * windows, and a client over the floor still owes nothing.
 */
const perCheckBytes = () => Math.ceil((proxyInboundMinRateBytes() * proxyStallCheckMs()) / 1000)

test('a body that pays one window in two is cut for being under the floor', async () => {
  // The shipped strike count, at a tenth of the shipped window: the sawtooth
  // needs the tolerance to be several windows wide to have anything to wipe.
  process.env.RELAY_PROXY_STALL_CHECK_MS = '250'
  process.env.RELAY_PROXY_STALL_STRIKES = '4'
  const { viewer_token } = await silentShare('ses_rate3', '203.0.113.53')
  const window = proxyStallCheckMs()
  const perCheck = perCheckBytes()
  // What one window is owed, paid every second window: HALF the floor, and
  // twice what the old rule really enforced. It was immortal under it — a
  // silent window never got to be the fourth in a row.
  const sawtooth = declareBodyAndWrite('ses_rate3', viewer_token, perCheck, window * 2)
  await sleep(6_000)
  console.log(`sawtooth: answer=${JSON.stringify(sawtooth.answer())} bytes sent=${sawtooth.sent()} perCheck=${perCheck}`)
  expect(sawtooth.answer()).toContain('408')

  const after = prompt('ses_rate3', viewer_token, BODY_LIMIT)
  await sleep(400)
  console.log(`sawtooth: after the cut, a full-size body = ${String(after.settled)}`)
  expect(after.settled).toBeUndefined()
}, 30_000)

test('a burst above the floor still buys the silence around it', async () => {
  process.env.RELAY_PROXY_STALL_CHECK_MS = '250'
  process.env.RELAY_PROXY_STALL_STRIKES = '4'
  const { viewer_token } = await silentShare('ses_rate4', '203.0.113.54')
  const window = proxyStallCheckMs()
  const strikes = proxyStallStrikes()
  // Twice the floor, delivered in bursts instead of evenly — the phone that
  // goes quiet on a handover and catches up, which the strike count exists to
  // forgive and the debt must keep forgiving.
  //
  // WITHIN the tolerance, not exactly on it: a burst every `strikes` windows
  // arrives at the same check that spends the last strike, so which of the two
  // the event loop runs first decides the test. That raced on two cores. What
  // the rule promises is forgiveness for a client that catches up before the
  // tolerance is out, and that is what this asserts.
  const bursty = declareBodyAndWrite('ses_rate4', viewer_token, 2 * strikes * perCheckBytes(), window * (strikes - 1))
  await sleep(6_000)
  console.log(`bursty: answer=${JSON.stringify(bursty.answer())} bytes sent=${bursty.sent()}`)
  expect(bursty.answer()).not.toContain('408')
  expect(bursty.answer()).toBe('')
}, 30_000)

test('a body arriving faster than the floor is never cut, however long it takes', async () => {
  const { viewer_token } = await silentShare('ses_rate2', '203.0.113.52')
  // 8 KiB/s for fifteen check windows: over the floor a held charge has to
  // pay for, and a fraction of the 92 KiB/s uplink this project is built for —
  // an upload that is slow, not one that is absent.
  const slow = declareBodyAndWrite('ses_rate2', viewer_token, 2 * KiB, 250)
  await sleep(3_000)
  console.log(`slow upload: answer=${JSON.stringify(slow.answer())} bytes sent=${slow.sent()}`)
  expect(slow.answer()).not.toContain('408')
  expect(slow.answer()).toBe('')
}, 30_000)
