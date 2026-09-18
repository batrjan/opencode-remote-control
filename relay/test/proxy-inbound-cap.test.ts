import { afterEach, beforeEach, expect, test } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'
import { WebSocket } from 'ws'
import { createApp } from '../src/server'
import { Store } from '../src/store'
import { BridgeClient } from '../src/ws/bridge'

/**
 * The INBOUND half of the proxy path's memory budget.
 *
 * The response half has had a process-wide ceiling, a per-share slice and a
 * watchdog since the last audit (see sendBounded). The request half had one
 * per-request limit and nothing else: every proxied POST body was buffered
 * whole, held for as long as the handler waited on the bridge (up to the prompt
 * timeout), and nothing counted the sum. Twenty concurrent 15 MiB prompts grew
 * the relay by ~915 MiB of RSS with not one refusal — a public registration and
 * a viewer token of one's own share, and every other share on the process died
 * with it.
 *
 * Three bounds are pinned here, each with a bridge that stays silent so the
 * bodies really are held: the share's own slice, the process-wide ceiling
 * across shares, and how many proxied POSTs one share may have in flight.
 * Plus the release: a request that goes away gives its bytes back.
 */

const KiB = 1024
const MiB = 1024 * KiB

const ENV = [
  'RELAY_PROXY_MAX_INBOUND_BYTES',
  'RELAY_PROXY_BODY_LIMIT_BYTES',
  'RELAY_PROXY_MAX_INFLIGHT_POSTS',
  'RELAY_PROMPT_TIMEOUT_MS',
  'ACTIVATE_FAIL_DELAY_MS',
]
const saved: Record<string, string | undefined> = {}

let server: http.Server
let store: Store
let bridge: BridgeClient
let base: string
const sockets: WebSocket[] = []
const aborts: AbortController[] = []

function start() {
  store = new Store()
  server = http.createServer()
  bridge = new BridgeClient(server, store)
  server.on('request', createApp(store, bridge))
  return new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      base = `127.0.0.1:${(server.address() as AddressInfo).port}`
      resolve()
    }),
  )
}

beforeEach(() => {
  for (const key of ENV) saved[key] = process.env[key]
  process.env.ACTIVATE_FAIL_DELAY_MS = '0'
  // The handler holds the body until the bridge answers; these never do.
  process.env.RELAY_PROMPT_TIMEOUT_MS = '4000'
})

afterEach(async () => {
  for (const ac of aborts.splice(0)) ac.abort()
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

/** One prompt of about `bytes`, tracked: `settled` stays undefined while the relay holds it. */
function prompt(session_id: string, viewer_token: string, bytes: number) {
  const ac = new AbortController()
  aborts.push(ac)
  const body = JSON.stringify({ messageID: 'msg_x', parts: [{ type: 'text', text: 'a'.repeat(bytes) }] })
  const tracked: { settled?: number; abort: () => void } = { abort: () => ac.abort() }
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
      tracked.settled = 0 // aborted or dropped
    })
  return tracked
}

/**
 * A chunked POST that has begun but not ended: the relay is holding what it may
 * still have to read. `finish()` completes the body, which is small.
 */
function openChunked(session_id: string, viewer_token: string) {
  const port = (server.address() as AddressInfo).port
  let done: (status: number) => void = () => {}
  const status = new Promise<number>((resolve) => (done = resolve))
  const req = http.request(
    {
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: `/session/${session_id}/prompt_async`,
      headers: { 'content-type': 'application/json', 'x-viewer-token': viewer_token },
    },
    (res) => {
      res.resume()
      res.on('end', () => done(res.statusCode ?? 0))
    },
  )
  req.on('error', () => done(0))
  req.write('{"messageID":"msg_x","parts":[{"type":"text","text":"')
  req.write('a'.repeat(1_000))
  return { status, finish: () => req.end('"}]}') }
}

test('one share may hold only its slice of the inbound ceiling at once', async () => {
  process.env.RELAY_PROXY_BODY_LIMIT_BYTES = String(MiB)
  process.env.RELAY_PROXY_MAX_INBOUND_BYTES = String(8 * MiB)
  await start()
  const { viewer_token } = await silentShare('ses_inbound1', '203.0.113.11')

  // The ceiling is never below sixteen body limits, so it is 16 MiB here and
  // the slice is two whole bodies (2 MiB): five 400 KiB bodies fit, the rest
  // must be refused rather than buffered behind them.
  const sent = Array.from({ length: 8 }, () => prompt('ses_inbound1', viewer_token, 400 * KiB))
  await sleep(600)
  const refused = sent.filter((p) => p.settled === 503).length
  const held = sent.filter((p) => p.settled === undefined).length
  console.log(`slice: refused=${refused} held=${held}`)
  expect(held).toBeLessThanOrEqual(5)
  expect(refused).toBe(8 - held)
}, 30_000)

test('a share has room for a second large paste at the SHIPPED defaults', async () => {
  // No env overrides: what a real install does with two viewers pasting a
  // screenshot at the same time. The slice used to be exactly ONE whole body
  // (an eighth of a ceiling that was eight body limits), so the second paste
  // was answered 503 `relay busy` by the share's own budget.
  await start()
  const { viewer_token } = await silentShare('ses_inbound6', '203.0.113.16')
  const first = prompt('ses_inbound6', viewer_token, 15 * MiB)
  const second = prompt('ses_inbound6', viewer_token, 15 * MiB)
  await sleep(1500)
  console.log(`two pastes at defaults: first=${String(first.settled)} second=${String(second.settled)}`)
  expect([first.settled, second.settled]).toEqual([undefined, undefined])
}, 30_000)

test('a share that has been refused for want of budget gets it back when the requests go', async () => {
  process.env.RELAY_PROXY_BODY_LIMIT_BYTES = String(MiB)
  process.env.RELAY_PROXY_MAX_INBOUND_BYTES = String(8 * MiB)
  await start()
  const { viewer_token } = await silentShare('ses_inbound2', '203.0.113.12')

  // Eight 400 KiB bodies against a slice of two whole bodies (2 MiB here).
  const first = Array.from({ length: 8 }, () => prompt('ses_inbound2', viewer_token, 400 * KiB))
  await sleep(600)
  expect(first.some((p) => p.settled === 503)).toBe(true)
  for (const p of first) p.abort()
  await sleep(300)
  // Nothing of this share is in flight any more, so a new body is admitted.
  const again = prompt('ses_inbound2', viewer_token, 400 * KiB)
  await sleep(400)
  console.log(`release: settled=${String(again.settled)}`)
  expect(again.settled).toBeUndefined()
}, 30_000)

test('the inbound ceiling is process-wide: shares well inside their own slice still meet it', async () => {
  process.env.RELAY_PROXY_BODY_LIMIT_BYTES = String(512 * KiB)
  process.env.RELAY_PROXY_MAX_INBOUND_BYTES = String(4 * MiB)
  await start()
  const shares = await Promise.all(
    Array.from({ length: 24 }, (_, i) => silentShare(`ses_inboundCt${i}`, `198.51.100.${i + 1}`)),
  )

  // One 400 KiB body each — well inside every share's own slice (the ceiling is
  // never below sixteen body limits, so the slice is two of them, 1 MiB here),
  // but twenty-four of them are more than the whole relay may hold.
  const sent = shares.map((s, i) => prompt(`ses_inboundCt${i}`, s.viewer_token, 400 * KiB))
  await sleep(800)
  const refused = sent.filter((p) => p.settled === 503).length
  console.log(`ceiling: refused=${refused} of ${sent.length}`)
  expect(refused).toBeGreaterThan(0)
}, 30_000)

test('an upload that declares no length is charged the most it could be', async () => {
  process.env.RELAY_PROXY_BODY_LIMIT_BYTES = String(MiB)
  process.env.RELAY_PROXY_MAX_INBOUND_BYTES = String(8 * MiB)
  await start()
  const { viewer_token } = await silentShare('ses_inbound4', '203.0.113.14')

  // A chunked upload says nothing about its size until it is over, so while it
  // is still arriving it is charged the most the parser would ever read from it
  // — one whole body each, so two of them are the share's whole slice.
  const uploads = [openChunked('ses_inbound4', viewer_token), openChunked('ses_inbound4', viewer_token)]
  await sleep(400)
  const next = prompt('ses_inbound4', viewer_token, 64)
  await sleep(300)
  console.log(`chunked charge: next=${String(next.settled)}`)
  expect(next.settled).toBe(503)
  for (const upload of uploads) upload.finish()
}, 30_000)

test('a body charged more than it turned out to be gives the difference back as soon as it is in', async () => {
  process.env.RELAY_PROXY_BODY_LIMIT_BYTES = String(MiB)
  process.env.RELAY_PROXY_MAX_INBOUND_BYTES = String(8 * MiB)
  await start()
  const { viewer_token } = await silentShare('ses_inbound7', '203.0.113.17')

  // Two chunked uploads: charged one whole body each while they are arriving,
  // because that is the most the parser would read from them.
  const uploads = [openChunked('ses_inbound7', viewer_token), openChunked('ses_inbound7', viewer_token)]
  await sleep(300)
  const duringUpload = prompt('ses_inbound7', viewer_token, 64)
  await sleep(300)
  expect(duringUpload.settled).toBe(503)

  // They were a kilobyte each. The share gets the difference back the moment
  // the bodies are in — not when the bridge finally answers them, which is the
  // prompt timeout away and is when the handler lets go of the parsed body.
  for (const upload of uploads) upload.finish()
  await sleep(400)
  const afterUpload = prompt('ses_inbound7', viewer_token, 64)
  await sleep(400)
  console.log(`settle: during=${String(duringUpload.settled)} after=${String(afterUpload.settled)}`)
  expect(afterUpload.settled).toBeUndefined()
}, 30_000)

test('a compressed body is charged what it inflates to, not what it arrived as', async () => {
  process.env.RELAY_PROXY_BODY_LIMIT_BYTES = String(MiB)
  process.env.RELAY_PROXY_MAX_INBOUND_BYTES = String(8 * MiB)
  await start()
  const { viewer_token } = await silentShare('ses_inbound8', '203.0.113.18')

  // The declared length is all the relay can charge before it reads, and a
  // gzipped body declares its COMPRESSED size — a few KiB that the parser then
  // inflates into most of a MiB of held heap. Two of them are the share's whole
  // slice, however little they weighed on the wire.
  const raw = Buffer.from(JSON.stringify({ messageID: 'msg_x', parts: [{ type: 'text', text: 'a'.repeat(900 * KiB) }] }))
  const squeezed = gzipSync(raw)
  expect(squeezed.length).toBeLessThan(64 * KiB)
  for (let i = 0; i < 2; i++) {
    const ac = new AbortController()
    aborts.push(ac)
    void fetch(`http://${base}/session/ses_inbound8/prompt_async`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
        'x-viewer-token': viewer_token,
      },
      body: squeezed,
      signal: ac.signal,
    }).catch(() => {})
  }
  await sleep(500)
  const next = prompt('ses_inbound8', viewer_token, 400 * KiB)
  await sleep(400)
  console.log(`gzip charge: next=${String(next.settled)}`)
  expect(next.settled).toBe(503)
}, 30_000)

test('a body over the per-request limit still gets its JSON 413, declared or not', async () => {
  // The charge must not cost the parser its own answer: it refuses an oversized
  // body from the Content-Length alone, and Node then dumps the rest of that
  // body — which an eager byte count read as an overrun and cut the 413 short.
  process.env.RELAY_PROXY_BODY_LIMIT_BYTES = String(4 * KiB)
  await start()
  const { viewer_token } = await silentShare('ses_inbound5', '203.0.113.15')
  const port = (server.address() as AddressInfo).port
  const body = JSON.stringify({ parts: [{ type: 'text', text: 'x'.repeat(20_000) }] })

  for (const declared of [true, false]) {
    const status = await new Promise<number | string>((resolve) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/session/ses_inbound5/message',
          headers: {
            'content-type': 'application/json',
            'x-viewer-token': viewer_token,
            ...(declared ? { 'content-length': Buffer.byteLength(body) } : {}),
          },
        },
        (res) => {
          res.resume()
          res.on('end', () => resolve(res.statusCode ?? 0))
        },
      )
      req.on('error', (err) => resolve(`error:${err.message}`))
      req.end(body)
    })
    console.log(`over limit (content-length: ${declared}): ${String(status)}`)
    expect(status).toBe(413)
  }
}, 30_000)

test('one share may not have unlimited proxied POSTs in flight', async () => {
  process.env.RELAY_PROXY_MAX_INFLIGHT_POSTS = '4'
  await start()
  const { viewer_token } = await silentShare('ses_inbound3', '203.0.113.13')

  // Bodies small enough that no byte budget is near: only the count refuses.
  const sent = Array.from({ length: 10 }, () => prompt('ses_inbound3', viewer_token, 64))
  await sleep(600)
  const refused = sent.filter((p) => p.settled === 503).length
  const held = sent.filter((p) => p.settled === undefined).length
  console.log(`count: refused=${refused} held=${held}`)
  expect(held).toBeLessThanOrEqual(4)
  expect(refused).toBe(10 - held)
}, 30_000)
