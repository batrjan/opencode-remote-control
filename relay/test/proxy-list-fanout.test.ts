import { afterEach, beforeEach, expect, test } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { createApp } from '../src/server'
import { Store } from '../src/store'
import { BridgeClient } from '../src/ws/bridge'

/**
 * One viewer request must not become an unbounded number of bridge requests.
 *
 * The filtered lists (/permission, /question, /session/status) decide each id
 * they carry by walking that session's parent chain through the bridge. The
 * list is the BRIDGE's, and registration is public, so its length is the
 * attacker's to choose: one GET /permission whose answer named N foreign
 * sessions became N entries in the relay's process-wide pending map, N timers
 * living the whole proxy timeout and N frames out — 100,000 of them and ~400 MB
 * of RSS from a single request, and every other share on the process paying for
 * it. nginx counts the one request that arrived, never the N it turned into.
 *
 * Both bounds are pinned here: how many unknown ids ONE list may walk, and how
 * many walks a share may have in flight at once (the second is what a stalled
 * bridge otherwise accumulates across requests). Filtering stays correct — an
 * id that is not walked is simply not in the share, which is what it was
 * already being filtered down to.
 */

process.env.ACTIVATE_FAIL_DELAY_MS = '0'

let server: http.Server
let store: Store
let bridge: BridgeClient
let base: string
const sockets: WebSocket[] = []

beforeEach(async () => {
  store = new Store()
  server = http.createServer()
  bridge = new BridgeClient(server, store)
  server.on('request', createApp(store, bridge))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate()
  bridge.close()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A registered share with a raw ws "bridge" and one activated viewer. */
async function share(session_id: string) {
  const res = await fetch(`http://${base}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.9' },
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
  return { ws, viewer_token }
}

test('a bridge list naming thousands of foreign sessions walks a bounded number of them', async () => {
  const bound = 'ses_fanout1'
  const { ws, viewer_token } = await share(bound)
  const N = 2000
  // One pending entry of the share itself, one of a real subagent, N of other
  // sessions the viewer must never see.
  const pending = [
    { id: 'per_own', sessionID: bound },
    { id: 'per_child', sessionID: 'ses_fanoutChild' },
    ...Array.from({ length: N }, (_, i) => ({ id: `per_${i}`, sessionID: `ses_foreign${i}` })),
  ]
  let walks = 0
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw)) as { type?: string; request_id?: string; path?: string }
    if (msg.type !== 'proxy') return
    const path = new URL(msg.path ?? '', 'http://x').pathname
    const reply = (status: number, body: unknown) =>
      ws.send(
        JSON.stringify({
          type: 'proxy_response',
          request_id: msg.request_id,
          status,
          contentType: 'application/json',
          body: JSON.stringify(body),
        }),
      )
    if (path === '/permission') return reply(200, pending)
    if (path.startsWith('/session/')) {
      walks++
      const id = path.split('/')[2]
      // The real subagent answers as itself; every other id is unknown to opencode.
      if (id === 'ses_fanoutChild') return reply(200, { id, parentID: bound })
      return reply(404, { error: 'not found' })
    }
    reply(200, {})
  })

  const res = await fetch(`http://${base}/permission`, { headers: { 'x-viewer-token': viewer_token } })
  expect(res.status).toBe(200)
  const body = (await res.json()) as Array<{ id: string }>
  console.log(`fan-out: listed=${pending.length} walks=${walks} kept=${body.length}`)

  // The share's own entry and its subagent's are kept; no foreign one is.
  expect(body.map((p) => p.id).sort()).toEqual(['per_child', 'per_own'])
  // And the cost of deciding that is bounded, not one walk per listed id.
  expect(walks).toBeLessThanOrEqual(256)
}, 30_000)

test('walks a stalled bridge never answers do not pile up across requests', async () => {
  const bound = 'ses_fanout2'
  const { ws, viewer_token } = await share(bound)
  let walks = 0
  const listOf = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `per_${prefix}${i}`, sessionID: `ses_${prefix}${i}` }))
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw)) as { type?: string; request_id?: string; path?: string }
    if (msg.type !== 'proxy') return
    const path = new URL(msg.path ?? '', 'http://x').pathname
    if (path === '/permission' || path === '/question') {
      ws.send(
        JSON.stringify({
          type: 'proxy_response',
          request_id: msg.request_id,
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(path === '/permission' ? listOf('a', 500) : listOf('b', 500)),
        }),
      )
      return
    }
    // A stalled bridge: the walks are dispatched and never answered, so they
    // hold their pending entry and timer for the whole proxy timeout.
    walks++
  })

  const stuck = [
    fetch(`http://${base}/permission`, { headers: { 'x-viewer-token': viewer_token } }).catch(() => undefined),
    fetch(`http://${base}/question`, { headers: { 'x-viewer-token': viewer_token } }).catch(() => undefined),
  ]
  await sleep(1_000)
  console.log(`stalled fan-out: dispatched=${walks}`)
  // The in-flight cap, not the per-list budget: it is sized against what the
  // share's bridge takes at once, so the walks never crowd out the viewer.
  expect(walks).toBeLessThanOrEqual(16)
  void stuck
}, 30_000)
