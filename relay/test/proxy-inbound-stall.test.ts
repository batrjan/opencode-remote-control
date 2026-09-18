import { afterEach, beforeEach, expect, test } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { createApp } from '../src/server'
import { Store } from '../src/store'
import { BridgeClient } from '../src/ws/bridge'

/**
 * The inbound budget's progress watchdog — the twin of the one the buffered
 * response half has had since the last audit (see sendBounded).
 *
 * A proxied POST is charged before its body is read and gives the charge back
 * when the RESPONSE ends. A body that never finishes arriving has no response
 * to end: the request sits in the parser holding its share of the budget, and
 * nothing in the relay ends it — Node's own requestTimeout, five minutes by
 * default, was the only clock. Declaring a maximal body and sending none of it
 * was therefore free, and what it bought was the share's whole slice, which is
 * the cheapest possible hold on a budget meant to be paid for in bytes.
 *
 * So the inbound side gets a watchdog of its own: a request that moves no byte
 * at all for proxyStallCheckMs x proxyStallStrikes is answered 408 and cut, and
 * its charge comes back. These two tests pin that end of it. The rule is no
 * longer only about silence — an arriving body has a rate floor to pay as well
 * (proxy-inbound-rate.test.ts) — so the slow upload below stays well over it.
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
  // A tenth of the shipped tolerance, so the test is seconds rather than ten of
  // them; the shipped one is ~10 s of complete silence.
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
  return { viewer_token }
}

/** One prompt of `bytes`, tracked: `settled` stays undefined while the relay holds it. */
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

/** Headers promising a maximal body, and not one byte of it — ever. */
function declareBodyAndSendNothing(session_id: string, viewer_token: string) {
  const socket = net.connect(port, '127.0.0.1')
  raw.push(socket)
  const seen: Buffer[] = []
  socket.on('error', () => {})
  socket.on('data', (chunk: Buffer) => seen.push(chunk))
  socket.on('connect', () => {
    socket.write(
      `POST /session/${session_id}/prompt_async HTTP/1.1\r\n` +
        `Host: ${base}\r\n` +
        `Content-Type: application/json\r\n` +
        `Content-Length: ${BODY_LIMIT}\r\n` +
        `x-viewer-token: ${viewer_token}\r\n\r\n`,
    )
  })
  return { answer: () => Buffer.concat(seen).toString('latin1') }
}

test('a body that stops arriving loses its request and gives the share its budget back', async () => {
  const { viewer_token } = await silentShare('ses_stall1', '203.0.113.31')

  // Two of them are the share's whole slice (two body limits), bought with two
  // sets of headers and no body at all.
  const stalled = [
    declareBodyAndSendNothing('ses_stall1', viewer_token),
    declareBodyAndSendNothing('ses_stall1', viewer_token),
  ]
  await sleep(250)
  const duringHold = prompt('ses_stall1', viewer_token, BODY_LIMIT)
  await sleep(250)
  expect(duringHold.settled, 'the declared bodies really are charged').toBe(503)

  // Past the tolerance (200 ms x 2): both are answered and cut, so the share
  // can use its slice again.
  await sleep(1_000)
  const answers = stalled.map((s) => s.answer().split('\r\n')[0])
  console.log(`stall: answers=${JSON.stringify(answers)}`)
  for (const answer of answers) expect(answer).toContain('408')

  const afterCut = prompt('ses_stall1', viewer_token, BODY_LIMIT)
  await sleep(400)
  console.log(`stall: during=${String(duringHold.settled)} after=${String(afterCut.settled)}`)
  expect(afterCut.settled).toBeUndefined()
}, 30_000)

test('a body that is still arriving is never cut for being slow', async () => {
  const { viewer_token } = await silentShare('ses_stall2', '203.0.113.32')
  const socket = net.connect(port, '127.0.0.1')
  raw.push(socket)
  const seen: Buffer[] = []
  socket.on('error', () => {})
  socket.on('data', (chunk: Buffer) => seen.push(chunk))
  const head = '{"messageID":"msg_x","parts":[{"type":"text","text":"'
  const tail = '"}]}'
  const filler = 'a'.repeat(4 * KiB)
  const total = head.length + tail.length + filler.length * 8
  await new Promise<void>((resolve) => socket.on('connect', () => resolve()))
  socket.write(
    `POST /session/ses_stall2/prompt_async HTTP/1.1\r\n` +
      `Host: ${base}\r\n` +
      `Content-Type: application/json\r\n` +
      `Content-Length: ${total}\r\n` +
      `x-viewer-token: ${viewer_token}\r\n\r\n` +
      head,
  )
  // 4 KiB every 300 ms: every check sees progress, though the whole body takes
  // far longer than the tolerance to arrive.
  for (let i = 0; i < 8; i++) {
    await sleep(300)
    socket.write(filler)
  }
  socket.write(tail)
  await sleep(500)
  const answer = Buffer.concat(seen).toString('latin1').split('\r\n')[0]
  console.log(`slow upload: answer=${JSON.stringify(answer)}`)
  // Still waiting on its own silent bridge — no answer at all, and certainly
  // not a 408.
  expect(answer).not.toContain('408')
  expect(answer).toBe('')
}, 30_000)
