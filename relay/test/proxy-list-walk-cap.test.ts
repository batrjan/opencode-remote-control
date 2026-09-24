import { afterEach, beforeEach, expect, test } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { createApp } from '../src/server'
import { Store } from '../src/store'
import { BridgeClient } from '../src/ws/bridge'

/**
 * How many ancestry walks the relay may have at ONE bridge at once, against
 * what that bridge will actually take.
 *
 * The walk caps were sized from the relay's own subagent cache (256), and the
 * bridge accepts 64 proxied requests in flight (maxInflightProxyRequests) and
 * answers everything past that 503 `bridge busy` — including the viewer's own
 * prompt, which is not a retry the relay makes. So one list of ~200 unknown ids
 * sent 64 walks through and had 137 refused, the refusals proved nothing so the
 * same ids were walked again on the next poll, and a prompt sent during the
 * flood was refused by the share's own bridge. The two caps are set by
 * different files and nothing made them agree.
 *
 * The relay's cap is now well below the bridge's, so filtering a list leaves
 * the bridge room for the viewer, and a walk refused for load is still an
 * UNKNOWN — never cached as "not in this share", which would hide a real
 * subagent for the life of the negative entry.
 */

process.env.ACTIVATE_FAIL_DELAY_MS = '0'

/** bridge/src/config.ts maxInflightProxyRequests() — what the real bridge takes at once. */
const BRIDGE_MAX_INFLIGHT = 64
/** relay/src/proxy/adapter.ts LIST_WALKS_IN_FLIGHT_MAX, plus the list request itself. */
const RELAY_WALKS_IN_FLIGHT = 16
/** What one opencode GET /session/<id> costs the bridge. */
const UPSTREAM_MS = 20

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

test('filtering a list leaves the share’s bridge room for the viewer’s own request', async () => {
  const bound = 'ses_walkcap'
  const child = 'ses_walkcapChild'
  const { ws, viewer_token } = await share(bound)
  const statuses: Record<string, unknown> = { [bound]: { type: 'busy' }, [child]: { type: 'busy' } }
  for (let i = 0; i < 200; i++) statuses[`ses_unknown${i}`] = { type: 'busy' }

  let inflight = 0
  let maxInflight = 0
  const refused: string[] = []
  // The gate the real bridge applies to everything the relay sends it.
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data)) as { type?: string; request_id?: string; path?: string; method?: string }
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
    if (inflight >= BRIDGE_MAX_INFLIGHT) {
      refused.push(`${String(msg.method)} ${path}`)
      return reply(503, { error: 'bridge busy' })
    }
    inflight++
    maxInflight = Math.max(maxInflight, inflight)
    setTimeout(() => {
      inflight--
      if (path === '/session/status') return reply(200, statuses)
      if (/^\/session\/[^/]+\/message$/.test(path)) return reply(200, { ok: true })
      const walked = /^\/session\/([^/]+)$/.exec(path)
      if (walked) {
        if (walked[1] === child) return reply(200, { id: child, parentID: bound })
        return reply(404, { error: 'not found' })
      }
      reply(200, {})
    }, UPSTREAM_MS)
  })

  const listed = fetch(`http://${base}/session/status`, { headers: { 'x-viewer-token': viewer_token } })
  await sleep(40) // let the walks get going
  const prompt = await fetch(`http://${base}/session/${bound}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-viewer-token': viewer_token },
    body: JSON.stringify({ parts: [{ type: 'text', text: 'hello' }] }),
  })
  const kept = Object.keys((await (await listed).json()) as Record<string, unknown>).sort()
  console.log(`walk cap: maxInflight=${maxInflight} prompt=${prompt.status} refused=${JSON.stringify(refused)}`)

  // The walks never fill the bridge, so nothing of the viewer's is refused.
  expect(maxInflight).toBeLessThanOrEqual(RELAY_WALKS_IN_FLIGHT + 1)
  expect(prompt.status).toBe(200)
  expect(refused).toEqual([])
  // And the filtering is still right: the share and its real subagent, nothing else.
  expect(kept).toEqual([bound, child].sort())
}, 30_000)

test('more unknown subagents than one list may walk are decided over the next polls', async () => {
  // What the lower cap costs: a list decides at most that many unknown ids at
  // once. Nothing is lost — each poll walks the next of them, because a walked
  // id is cached and an unwalked one is not remembered as foreign.
  const bound = 'ses_walkwave'
  const { ws, viewer_token } = await share(bound)
  const children = Array.from({ length: 40 }, (_, i) => `ses_walkwaveChild${i}`)
  const statuses: Record<string, unknown> = { [bound]: { type: 'busy' } }
  for (const child of children) statuses[child] = { type: 'busy' }

  ws.on('message', (data) => {
    const msg = JSON.parse(String(data)) as { type?: string; request_id?: string; path?: string }
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
    if (path === '/session/status') return reply(200, statuses)
    const walked = /^\/session\/([^/]+)$/.exec(path)
    if (walked && children.includes(walked[1])) return reply(200, { id: walked[1], parentID: bound })
    reply(404, { error: 'not found' })
  })

  const seen: number[] = []
  for (let poll = 0; poll < 3; poll++) {
    const res = await fetch(`http://${base}/session/status`, { headers: { 'x-viewer-token': viewer_token } })
    seen.push(Object.keys((await res.json()) as Record<string, unknown>).length)
  }
  console.log(`walk waves: kept per poll=${JSON.stringify(seen)}`)
  expect(seen[0]).toBeLessThan(children.length + 1)
  expect(seen.at(-1)).toBe(children.length + 1)
}, 30_000)

test('a walk the bridge refused for load is an unknown, not a proven “not in this share”', async () => {
  const bound = 'ses_walkbusy'
  const child = 'ses_walkbusyChild'
  const { ws, viewer_token } = await share(bound)
  const statuses: Record<string, unknown> = { [bound]: { type: 'busy' }, [child]: { type: 'busy' } }

  // The first walk of the child is refused the way a loaded bridge refuses it;
  // everything after is answered normally.
  let busyOnce = true
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data)) as { type?: string; request_id?: string; path?: string }
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
    if (path === '/session/status') return reply(200, statuses)
    const walked = /^\/session\/([^/]+)$/.exec(path)
    if (walked?.[1] === child) {
      if (busyOnce) {
        busyOnce = false
        return reply(503, { error: 'bridge busy' })
      }
      return reply(200, { id: child, parentID: bound })
    }
    reply(404, { error: 'not found' })
  })

  const poll = async () =>
    Object.keys((await (await fetch(`http://${base}/session/status`, { headers: { 'x-viewer-token': viewer_token } })).json()) as Record<string, unknown>).sort()

  const first = await poll()
  const second = await poll()
  console.log(`busy walk: first=${JSON.stringify(first)} second=${JSON.stringify(second)}`)
  // Refused, so unproven, so left out of the list this once...
  expect(first).toEqual([bound])
  // ...and walked again rather than remembered as foreign for the negative TTL.
  expect(second).toEqual([bound, child].sort())
}, 30_000)
