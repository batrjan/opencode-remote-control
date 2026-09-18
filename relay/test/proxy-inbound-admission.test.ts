import { afterEach, beforeEach, expect, test } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'
import { WebSocket } from 'ws'
import { createApp } from '../src/server'
import { Store } from '../src/store'
import { BridgeClient } from '../src/ws/bridge'
import { proxyBodyLimitBytes, proxyInboundShareBytes, proxyMaxInboundBytes } from '../src/config'

/**
 * What the inbound budget ADMITS — not what it corrects afterwards.
 *
 * proxy-inbound-cap.test.ts pins the correction: a body that turned out bigger
 * or smaller than declared moves the charge once the parser has read it whole.
 * That is bookkeeping, and bookkeeping cannot refuse anything — by the time it
 * runs the body is already in the heap. Every bound the budget actually keeps
 * is decided in admitInboundBody, from headers alone, and two ways of writing
 * those headers walked straight past it:
 *
 *  - `Content-Encoding: gzip` made the declared length the size on the WIRE.
 *    Bodies of 24 KiB each were admitted as 24 KiB and inflated into 24 MiB of
 *    held heap apiece; 32 of them (one free registration, under 1 MB of
 *    uplink) held ~768 MiB against a 400 MiB ceiling and a 50 MiB share slice,
 *    took the relay's RSS from 176 to 2615 MiB, and answered a 55-byte prompt
 *    from ANOTHER share — the request the reserve exists for — with 503.
 *  - A POST with neither `Content-Length` nor `Transfer-Encoding` was charged
 *    the whole per-request limit for a body that does not exist. body-parser
 *    returns before reading anything (its own hasBody test), so the verify hook
 *    that settles the charge never ran, and the stall watchdog removes itself
 *    on `req.complete`, so no 408 ever came either: two sets of headers held a
 *    share's entire slice until the response ended, up to a prompt timeout
 *    away. Same for a body the parser skips by content-type.
 *
 * So these tests send the headers and look at who gets in, at bounds scaled
 * down to keep the run cheap. The shipped numbers are what the review measured;
 * the shapes here are the same.
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
let port: number
const sockets: WebSocket[] = []
const raw: net.Socket[] = []
const aborts: AbortController[] = []

function start() {
  store = new Store()
  server = http.createServer()
  bridge = new BridgeClient(server, store)
  server.on('request', createApp(store, bridge))
  return new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as AddressInfo).port
      base = `127.0.0.1:${port}`
      resolve()
    }),
  )
}

beforeEach(() => {
  for (const key of ENV) saved[key] = process.env[key]
  process.env.ACTIVATE_FAIL_DELAY_MS = '0'
  // The handler holds the body until the bridge answers; these never do.
  process.env.RELAY_PROMPT_TIMEOUT_MS = '6000'
  // A 512 KiB body limit, so the ceiling is its floor of sixteen body limits
  // (8 MiB), a share's slice is two of them (1 MiB) and a small body is 64 KiB.
  process.env.RELAY_PROXY_BODY_LIMIT_BYTES = String(512 * KiB)
  process.env.RELAY_PROXY_MAX_INBOUND_BYTES = String(4 * MiB)
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
function promptBody(bytes: number): Buffer {
  const skeleton = JSON.stringify({ messageID: 'msg_x', parts: [{ type: 'text', text: '' }] })
  return Buffer.from(
    JSON.stringify({
      messageID: 'msg_x',
      parts: [{ type: 'text', text: 'a'.repeat(Math.max(bytes - skeleton.length, 1)) }],
    }),
  )
}

/** One POST the relay holds; `settled` stays undefined while it is held. */
function post(session_id: string, viewer_token: string, body: Buffer, headers: Record<string, string> = {}) {
  const ac = new AbortController()
  aborts.push(ac)
  const tracked: { settled?: number } = {}
  void fetch(`http://${base}/session/${session_id}/prompt_async`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-viewer-token': viewer_token, ...headers },
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
 * Request headers and nothing else: no `Content-Length`, no
 * `Transfer-Encoding`, so by HTTP (and by body-parser's hasBody test) this
 * request HAS no body and the parser will not read a byte of the socket.
 */
function headersOnly(session_id: string, viewer_token: string) {
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
        `x-viewer-token: ${viewer_token}\r\n\r\n`,
    )
  })
  return { answer: () => Buffer.concat(seen).toString('latin1').split('\r\n')[0] }
}

test('a compressed body is ADMITTED on what it may inflate to, not on its size on the wire', async () => {
  process.env.RELAY_PROXY_MAX_INFLIGHT_POSTS = '24'
  await start()
  const attacker = await silentShare('ses_adm_gz', '203.0.113.41')
  const victim = await silentShare('ses_adm_vic', '198.51.100.41')

  // 450 KiB of prompt, half a kilobyte on the wire. The parser inflates it
  // before the charge is ever corrected, so what the relay holds is the
  // inflated size — which is why the ADMISSION has to assume it.
  const inflated = promptBody(450 * KiB)
  const squeezed = gzipSync(inflated)
  expect(squeezed.length).toBeLessThan(KiB)
  const sent = Array.from({ length: 24 }, () =>
    post('ses_adm_gz', attacker.viewer_token, squeezed, { 'Content-Encoding': 'gzip' }),
  )
  await sleep(2_000)
  const held = sent.filter((p) => p.settled === undefined).length
  const refused = sent.filter((p) => p.settled === 503).length
  console.log(
    `gzip admission: wire=${squeezed.length}B inflated=${inflated.length}B held=${held} 503=${refused} ` +
      `implied=${Math.round((held * inflated.length) / KiB)}KiB of a ${proxyInboundShareBytes() / KiB}KiB slice`,
  )

  // The request the reserve exists for — another share's small prompt, holding
  // nothing — measured before anything is asserted, because it is the whole
  // point: what this buys is a cross-tenant outage.
  const quiet = post('ses_adm_vic', victim.viewer_token, promptBody(55))
  await sleep(700)
  console.log(`gzip admission: other share's quiet prompt = ${String(quiet.settled)}`)

  // The share's slice is two whole bodies, and a gzip header does not buy a
  // third: what is held must fit the slice it was admitted against.
  expect(held).toBeLessThanOrEqual(proxyInboundShareBytes() / proxyBodyLimitBytes())
  expect(held * inflated.length).toBeLessThanOrEqual(proxyInboundShareBytes())
  expect(refused).toBe(sent.length - held)
  expect(quiet.settled).toBeUndefined()
}, 40_000)

test('a POST that declares no body at all is charged for none', async () => {
  await start()
  const { viewer_token } = await silentShare('ses_adm_none', '203.0.113.42')

  // Two of these were the share's whole slice (a body limit each) for as long
  // as the response took — a prompt timeout, renewed — with no body to read,
  // nothing to settle the charge, and no 408 either, because Node marks such a
  // request complete before the watchdog's first tick.
  const bodyless = [headersOnly('ses_adm_none', viewer_token), headersOnly('ses_adm_none', viewer_token)]
  await sleep(600)

  const paste = post('ses_adm_none', viewer_token, promptBody(450 * KiB))
  await sleep(700)
  console.log(`bodyless: paste=${String(paste.settled)} answers=${JSON.stringify(bodyless.map((b) => b.answer()))}`)
  // The slice is untouched, so a real body of nearly the whole per-request
  // limit still gets in.
  expect(paste.settled).toBeUndefined()
  // And the bodyless requests are not refused or cut themselves — they are
  // ordinary requests waiting on their own (silent) bridge.
  for (const b of bodyless) expect(b.answer()).toBe('')
}, 40_000)

test('a body the parser skips by content-type does not stay charged for its declared length', async () => {
  await start()
  const { viewer_token } = await silentShare('ses_adm_skip', '203.0.113.43')

  // express.json parses application/json only. A text/plain body with an
  // honest length is admitted for that length, then skipped — the verify hook
  // that settles the charge never runs, so the relay went on paying for bytes
  // it had not kept, until the response ended.
  const skipped = [1, 2].map(() =>
    post('ses_adm_skip', viewer_token, promptBody(450 * KiB), { 'Content-Type': 'text/plain' }),
  )
  await sleep(800)
  const paste = post('ses_adm_skip', viewer_token, promptBody(450 * KiB))
  await sleep(700)
  console.log(
    `skipped by type: skipped=${JSON.stringify(skipped.map((s) => s.settled))} paste=${String(paste.settled)}`,
  )
  expect(paste.settled).toBeUndefined()
}, 40_000)

test('the shipped ceiling still refuses what it should: uncompressed bodies past the slice', async () => {
  // The control for the first test — the same budget doing its job when the
  // sender does not lie about the size. Kept here so a fix that simply stopped
  // charging anything would fail.
  await start()
  const { viewer_token } = await silentShare('ses_adm_ctl', '203.0.113.44')
  const sent = Array.from({ length: 6 }, () => post('ses_adm_ctl', viewer_token, promptBody(450 * KiB)))
  await sleep(1_200)
  const held = sent.filter((p) => p.settled === undefined).length
  console.log(`control: held=${held} 503=${sent.filter((p) => p.settled === 503).length}`)
  expect(held).toBe(2)
  expect(held * 450 * KiB).toBeLessThanOrEqual(proxyMaxInboundBytes())
}, 40_000)
