import { afterEach, beforeEach, expect, test } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { createApp } from '../src/server'
import { Store } from '../src/store'
import { BridgeClient } from '../src/ws/bridge'

/**
 * The inbound budget's CROSS-TENANT property: a share that is holding nothing
 * can always act.
 *
 * The ceiling and the per-share slice bound memory, but the first shape of them
 * gave one share exactly one whole body (ceiling / 8, floored at one body limit,
 * against a ceiling of eight body limits), so EIGHT public registrations holding
 * one maximal body each spent the whole process budget — and every other share's
 * proxied POST (a prompt, a permission answer, a question answer, an abort, a
 * shell command) was answered 503 `relay busy` while its GETs and its event
 * stream went on working. The share looked alive and took no action at all: the
 * OOM the budget closed had become a cheap, deterministic outage for everyone
 * else.
 *
 * Two things are pinned here. A share that holds nothing keeps a reserve of the
 * ceiling for a SMALL body however full the relay is, and the reserve is not a
 * way past the ceiling for a large one.
 *
 * Budgets are scaled down by env so the test moves kilobytes, not hundreds of
 * MB; the relationships between them are the shipped ones.
 */

const KiB = 1024
const BODY_LIMIT = 64 * KiB

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

beforeEach(async () => {
  for (const key of ENV) saved[key] = process.env[key]
  process.env.ACTIVATE_FAIL_DELAY_MS = '0'
  // The bodies have to still be held while the victim asks, so the bridges stay
  // silent and the prompt clock is longer than the test.
  process.env.RELAY_PROMPT_TIMEOUT_MS = '15000'
  process.env.RELAY_PROXY_BODY_LIMIT_BYTES = String(BODY_LIMIT)
  process.env.RELAY_PROXY_MAX_INBOUND_BYTES = String(8 * BODY_LIMIT)
  await start()
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

/** A prompt body of EXACTLY `bytes` on the wire (the charge is the declared length). */
function bodyOf(bytes: number): string {
  const skeleton = JSON.stringify({ messageID: 'msg_x', parts: [{ type: 'text', text: '' }] })
  return JSON.stringify({ messageID: 'msg_x', parts: [{ type: 'text', text: 'a'.repeat(bytes - skeleton.length) }] })
}

/** One prompt of `bytes` on the wire, tracked: `settled` stays undefined while the relay holds it. */
function prompt(session_id: string, viewer_token: string, bytes: number) {
  const ac = new AbortController()
  aborts.push(ac)
  const body = bodyOf(bytes)
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
      tracked.settled = 0 // aborted or dropped
    })
  return tracked
}

/** Eight shares pushing maximal bodies until the relay refuses them: the ceiling is full. */
async function fillTheRelay(): Promise<number> {
  const held: { settled?: number }[] = []
  for (let i = 0; i < 8; i++) {
    const id = `ses_flood${i}`
    const { viewer_token } = await silentShare(id, `10.0.0.${i + 1}`)
    for (let n = 0; n < 4; n++) held.push(prompt(id, viewer_token, BODY_LIMIT))
  }
  await sleep(900)
  const refused = held.filter((p) => p.settled === 503).length
  // Whatever the slice is, the flood has to have hit the ceiling for the test
  // below to mean anything.
  expect(refused).toBeGreaterThan(0)
  return held.filter((p) => p.settled === undefined).length
}

test('a share holding nothing can still send a small POST while eight others hold the whole ceiling', async () => {
  const holding = await fillTheRelay()

  const { viewer_token } = await silentShare('ses_victim', '10.9.9.9')
  const victim = prompt('ses_victim', viewer_token, 200)
  await sleep(700)
  console.log(`starvation: flood holds ${holding} bodies, victim settled=${String(victim.settled)}`)
  // 503 = 'relay busy': the victim's own share has spent nothing at all and is
  // refused for what other registrations hold.
  expect(victim.settled).not.toBe(503)
  expect(victim.settled).toBeUndefined() // held by its own silent bridge, as it should be
}, 60_000)

test('CONTROL: the same small POST with nobody holding the ceiling', async () => {
  const { viewer_token } = await silentShare('ses_control', '10.9.9.8')
  const victim = prompt('ses_control', viewer_token, 200)
  await sleep(700)
  console.log(`control: victim settled=${String(victim.settled)}`)
  expect(victim.settled).toBeUndefined()
}, 60_000)

test('the reserve is for a small body only: a full-sized one still meets the full ceiling', async () => {
  await fillTheRelay()

  const { viewer_token } = await silentShare('ses_victimBig', '10.9.9.7')
  const big = prompt('ses_victimBig', viewer_token, BODY_LIMIT)
  await sleep(700)
  console.log(`reserve scope: big body settled=${String(big.settled)}`)
  expect(big.settled).toBe(503)
}, 60_000)
