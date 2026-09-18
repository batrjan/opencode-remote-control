import { afterEach, beforeEach, expect, test } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { createApp } from '../src/server'
import { Store } from '../src/store'
import { BridgeClient } from '../src/ws/bridge'
import {
  proxyInboundReserveBytes,
  proxyInboundShareBytes,
  proxyInboundSmallBodyBytes,
  proxyMaxInboundBytes,
} from '../src/config'

/**
 * What the inbound reserve is, exactly — and what it is not.
 *
 * README promises that "about 64 such quiet shares can act through that reserve
 * at once, however full the relay is". The first half is a real bound and is
 * pinned here: the reserve is a POOL of reserve/small quiet bodies, every
 * quiet body is at most one small body of it, and the sum of everything held
 * never passes the ceiling.
 *
 * The second half is what this file exists to be honest about: the pool is
 * first come, first served, and registration is public, so the shares acting
 * through it are whoever asked first — an attacker's free registrations
 * included. What the reserve buys is the PRICE of a total cross-tenant outage
 * (eight registrations holding maximal bodies, plus one per small slot of the
 * reserve, each with a bridge of its own that answers nothing), not its
 * impossibility. Nothing in the relay can tell one public registration from
 * another, so this is a bound on memory, not a guarantee of fairness, and the
 * comment on proxyInboundReserveBytes says so.
 */

const KiB = 1024
const MiB = 1024 * KiB

const ENV = [
  'RELAY_PROXY_MAX_INBOUND_BYTES',
  'RELAY_PROXY_BODY_LIMIT_BYTES',
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

beforeEach(async () => {
  for (const key of ENV) saved[key] = process.env[key]
  process.env.ACTIVATE_FAIL_DELAY_MS = '0'
  process.env.RELAY_PROMPT_TIMEOUT_MS = '8000'
  // 512 KiB bodies: an 8 MiB ceiling (its floor of sixteen body limits), a
  // 1 MiB slice, a 1 MiB reserve and a 64 KiB small body — sixteen quiet
  // shares in the reserve, the same arithmetic as the shipped 64.
  process.env.RELAY_PROXY_BODY_LIMIT_BYTES = String(512 * KiB)
  process.env.RELAY_PROXY_MAX_INBOUND_BYTES = String(4 * MiB)
  store = new Store()
  server = http.createServer()
  bridge = new BridgeClient(server, store)
  server.on('request', createApp(store, bridge))
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      base = `127.0.0.1:${(server.address() as AddressInfo).port}`
      resolve()
    }),
  )
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
  const tracked: { settled?: number; size: number } = { size: Buffer.byteLength(body) }
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

test('the reserve is a bounded pool of quiet bodies, and it is first come, first served', async () => {
  const slots = proxyInboundReserveBytes() / proxyInboundSmallBodyBytes()
  const fill = proxyInboundShareBytes() / (480 * KiB) // bodies per share, rounded down by the slice
  const bigShares = Math.ceil((proxyMaxInboundBytes() - proxyInboundReserveBytes()) / proxyInboundShareBytes())

  // Fill the relay with ordinary bodies: every share at its slice, together the
  // whole ceiling but the reserve.
  const big: { settled?: number; size: number }[] = []
  for (let i = 0; i < bigShares; i++) {
    const share = await silentShare(`ses_res_big${i}`, `203.0.113.${60 + Math.floor(i / 4)}`)
    for (let n = 0; n < fill; n++) big.push(prompt(`ses_res_big${i}`, share.viewer_token, 480 * KiB))
  }
  await sleep(1_200)
  const bigHeld = big.filter((p) => p.settled === undefined)
  console.log(`reserve: relay filled with ${bigHeld.length} ordinary bodies, ${big.length - bigHeld.length} refused`)

  // Now the quiet ones: small bodies from shares holding nothing at all, which
  // is what the reserve is for. Twice as many as the pool has room for.
  const quiet: { settled?: number; size: number }[] = []
  for (let i = 0; i < slots * 2; i++) {
    const share = await silentShare(`ses_res_q${i}`, `198.51.100.${20 + Math.floor(i / 4)}`)
    quiet.push(prompt(`ses_res_q${i}`, share.viewer_token, 60 * KiB))
    await sleep(15)
  }
  await sleep(800)
  const quietHeld = quiet.filter((p) => p.settled === undefined)
  const held = [...bigHeld, ...quietHeld].reduce((sum, p) => sum + p.size, 0)
  console.log(
    `reserve: quiet shares admitted=${quietHeld.length} refused=${quiet.filter((p) => p.settled === 503).length} ` +
      `of ${quiet.length} (pool holds ${slots}); bytes held=${Math.round(held / KiB)}KiB of a ${
        proxyMaxInboundBytes() / KiB
      }KiB ceiling`,
  )

  // However full the relay is, the reserve's own worth of quiet shares got in…
  expect(quietHeld.length).toBeGreaterThanOrEqual(slots)
  // …and not one byte more than the ceiling is ever held for them.
  expect(held).toBeLessThanOrEqual(proxyMaxInboundBytes())
  // …and the rest are refused rather than buffered.
  expect(quiet.filter((p) => p.settled === 503).length).toBe(quiet.length - quietHeld.length)

  // Which is the honest half, and it is pinned too: with the pool bought out,
  // the next quiet share — as honest as any of them, and holding nothing — is
  // refused. The reserve bounds MEMORY, not fairness: nothing in the relay can
  // tell one public registration from another, so what it costs an attacker to
  // deny every other share is one registration, with a bridge of its own that
  // answers nothing, per slot of the pool — and never an OOM, because the
  // refusal is a 503 and not a buffer.
  const late = await silentShare('ses_res_late', '198.51.100.90')
  const lateBody = prompt('ses_res_late', late.viewer_token, 60 * KiB)
  await sleep(600)
  console.log(`reserve: a quiet share arriving after the pool is bought out = ${String(lateBody.settled)}`)
  expect(lateBody.settled).toBe(503)
}, 60_000)
