import { afterEach, beforeEach, expect, test } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { createApp } from '../src/server'
import { Store } from '../src/store'
import { BridgeClient } from '../src/ws/bridge'

/**
 * An inbound charge comes back when the SOCKET dies, not only when a response
 * of its own ends.
 *
 * The charge was released on the life of the RESPONSE ('finish'/'close'), which
 * is right for the request Node is currently answering. It is not right for the
 * ones behind it: on one HTTP/1.1 socket Node emits 'request' for every
 * pipelined request at once, but only the first response has the socket
 * assigned — the rest sit in the outgoing queue. A queued response whose socket
 * dies before the queue reaches it emits neither 'finish' nor 'close', so its
 * charge and its in-flight slot were never given back, for the life of the
 * process. Four pipelined 2 MiB POSTs leaked 6 MiB and 3 of 32 slots per
 * socket, and because the charge is settled to the INFLATED size, a gzip body
 * turned 583 KiB of uplink into 360 MiB held forever.
 *
 * Unreachable through the shipped nginx (which buffers bodies and does not
 * pipeline upstream), but it is the one invariant the whole inbound budget
 * rests on: every admitted request gives its bytes back.
 *
 * The subscription has to be on the SOCKET's 'close', never on the request's:
 * an IncomingMessage closes when its body has been READ, which would hand the
 * charge back while the handler still holds the parsed body and waits on the
 * bridge — the inbound DoS the budget was written against.
 */

const KiB = 1024
const BODY_LIMIT = 64 * KiB
// The relay's own floor: the ceiling is never below sixteen body limits, so a
// share's eighth of it is exactly two of them here.
const SHARE_SLICE = 2 * BODY_LIMIT

const ENV = [
  'RELAY_PROXY_MAX_INBOUND_BYTES',
  'RELAY_PROXY_BODY_LIMIT_BYTES',
  'RELAY_PROXY_MAX_INFLIGHT_POSTS',
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
  // Long enough that nothing in these tests is answered by a bridge timeout:
  // what is measured is the budget while the handlers are still waiting.
  process.env.RELAY_PROMPT_TIMEOUT_MS = '20000'
  process.env.RELAY_PROXY_BODY_LIMIT_BYTES = String(BODY_LIMIT)
  process.env.RELAY_PROXY_MAX_INBOUND_BYTES = String(16 * BODY_LIMIT)
  // Above what any test here pipelines, so what refuses a request is the byte
  // budget; the slot test lowers it to two for itself.
  process.env.RELAY_PROXY_MAX_INFLIGHT_POSTS = '8'
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

/** A prompt body of exactly `bytes`. */
function promptBody(bytes: number): string {
  const skeleton = JSON.stringify({ messageID: 'msg_x', parts: [{ type: 'text', text: '' }] })
  return JSON.stringify({
    messageID: 'msg_x',
    parts: [{ type: 'text', text: 'a'.repeat(Math.max(bytes - skeleton.length, 1)) }],
  })
}

/** One prompt of `bytes`, tracked: `settled` stays undefined while it is held. */
function prompt(session_id: string, viewer_token: string, bytes: number) {
  const ac = new AbortController()
  aborts.push(ac)
  const tracked: { settled?: number } = {}
  void fetch(`http://${base}/session/${session_id}/prompt_async`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-viewer-token': viewer_token },
    body: promptBody(bytes),
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

/**
 * `count` complete POSTs of `bytes` each, written back to back on ONE socket
 * before a single response can come back — so only the first response is ever
 * given the socket, and the rest are queued.
 */
function pipeline(session_id: string, viewer_token: string, count: number, bytes: number) {
  const socket = net.connect(port, '127.0.0.1')
  raw.push(socket)
  const seen: Buffer[] = []
  socket.on('error', () => {})
  socket.on('data', (chunk: Buffer) => seen.push(chunk))
  const body = promptBody(bytes)
  socket.on('connect', () => {
    let wire = ''
    for (let i = 0; i < count; i++) {
      wire +=
        `POST /session/${session_id}/prompt_async HTTP/1.1\r\n` +
        `Host: ${base}\r\n` +
        `Content-Type: application/json\r\n` +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        `x-viewer-token: ${viewer_token}\r\n\r\n` +
        body
    }
    socket.write(wire)
  })
  return {
    kill: () => socket.destroy(),
    answers: () => Buffer.concat(seen).toString('latin1'),
  }
}

test('a pipelined POST gives its bytes back when the socket dies under it', async () => {
  const { viewer_token } = await silentShare('ses_pipe1', '203.0.113.71')

  // Four half-limit bodies are the share's whole slice, and they arrive on one
  // socket: only the first response is given the socket, the other three are
  // queued behind it.
  const pipelined = pipeline('ses_pipe1', viewer_token, 4, BODY_LIMIT / 2)
  await sleep(600)
  const duringHold = prompt('ses_pipe1', viewer_token, BODY_LIMIT)
  await sleep(300)
  expect(duringHold.settled, 'all four pipelined bodies really are charged').toBe(503)
  expect(pipelined.answers(), 'no pipelined request was answered yet').toBe('')

  // The socket dies with both still waiting on their silent bridge. Whatever
  // Node does with the queued response, the bytes are the relay's to give back.
  pipelined.kill()
  await sleep(1_000)

  const afterDeath = prompt('ses_pipe1', viewer_token, BODY_LIMIT)
  await sleep(500)
  console.log(`pipelined: during=${String(duringHold.settled)} after socket death=${String(afterDeath.settled)}`)
  expect(
    afterDeath.settled,
    `the share is still charged for a dead socket's queued request (slice ${SHARE_SLICE} B)`,
  ).toBeUndefined()
}, 30_000)

test('a pipelined POST gives its in-flight slot back when the socket dies under it', async () => {
  process.env.RELAY_PROXY_MAX_INFLIGHT_POSTS = '2'
  const { viewer_token } = await silentShare('ses_pipe2', '203.0.113.72')

  // Small enough to be charged nothing that matters (the quiet reserve): what
  // is counted here is the in-flight slot, capped at two above.
  const pipelined = pipeline('ses_pipe2', viewer_token, 2, 512)
  await sleep(600)
  const duringHold = prompt('ses_pipe2', viewer_token, 512)
  await sleep(300)
  expect(duringHold.settled, 'both pipelined posts really hold a slot').toBe(503)

  pipelined.kill()
  await sleep(1_000)

  const first = prompt('ses_pipe2', viewer_token, 512)
  const second = prompt('ses_pipe2', viewer_token, 512)
  await sleep(500)
  console.log(`pipelined slots: after socket death first=${String(first.settled)} second=${String(second.settled)}`)
  expect(first.settled, 'a slot of the dead socket is still held').toBeUndefined()
  expect(second.settled, 'a slot of the dead socket is still held').toBeUndefined()
}, 30_000)

test('a client cannot write the relay a listener warning by pipelining', async () => {
  // The socket is watched once per SOCKET, not once per request. Per request,
  // a client holding more than ten posts on one socket — the cap is
  // proxyMaxInflightPosts, 32 — made Node print
  // "MaxListenersExceededWarning: ... 11 close listeners added to [Socket]",
  // which is a line of the relay's log at a stranger's choosing.
  process.env.RELAY_PROXY_MAX_INFLIGHT_POSTS = '32'
  const warnings: string[] = []
  const onWarning = (w: Error) => warnings.push(`${w.name}: ${w.message}`)
  process.on('warning', onWarning)
  try {
    const { viewer_token } = await silentShare('ses_pipe3', '203.0.113.73')
    const pipelined = pipeline('ses_pipe3', viewer_token, 20, 512)
    await sleep(1_000)
    pipelined.kill()
    await sleep(600)
    console.log(`pipelined listeners: warnings=${JSON.stringify(warnings)}`)
    expect(warnings.filter((w) => w.includes('MaxListeners'))).toEqual([])

    // And twenty at once all give their slots back, not just the ten a
    // per-request listener would have been allowed.
    const after = prompt('ses_pipe3', viewer_token, 512)
    await sleep(400)
    expect(after.settled, 'slots of the dead socket are still held').toBeUndefined()
  } finally {
    process.off('warning', onWarning)
  }
}, 30_000)
