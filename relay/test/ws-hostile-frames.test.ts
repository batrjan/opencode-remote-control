import { afterEach, beforeEach, expect, test } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { Store } from '../src/store'
import { BridgeClient } from '../src/ws/bridge'

/**
 * What a bridge sends is attacker-controlled: registration is public, so
 * anyone can hold a valid bridge_token and speak this protocol by hand. Every
 * field read off a frame is therefore read off a value whose shape was never
 * agreed to — and the read happens in the synchronous ws 'message' handler,
 * where a throw is an uncaught exception and, in production, the end of the
 * process serving every other tenant.
 *
 * relay-process-resilience.test.ts pins the process surviving. These pin the
 * handler itself: a frame it cannot use costs the one request it belongs to.
 */

let server: http.Server
let store: Store
let bridge: BridgeClient
let port: number

beforeEach(async () => {
  store = new Store()
  server = http.createServer((_req, res) => res.end('ok'))
  bridge = new BridgeClient(server, store)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterEach(async () => {
  bridge.close()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function connectBridge(session_id: string): Promise<WebSocket> {
  const { bridge_token } = store.createSession(session_id, '/work', 'title', '203.0.113.7')
  const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge?session_id=${session_id}`, {
    headers: { 'x-bridge-token': bridge_token },
  })
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  ws.on('error', () => {})
  return ws
}

/** The next relay → bridge frame of the given type, as the bridge sees it. */
function nextFrame(ws: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${type} frame`)), 2000)
    const onMessage = (raw: WebSocket.RawData) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(String(raw)) as Record<string, unknown>
      } catch {
        return
      }
      if (msg.type !== type) return
      clearTimeout(timer)
      ws.off('message', onMessage)
      resolve(msg)
    }
    ws.on('message', onMessage)
  })
}

/** How a pending request ended, or that it never ended at all. */
function outcome(promise: Promise<unknown>, ms = 1500): Promise<string> {
  return Promise.race([
    promise.then(
      () => 'resolved',
      (err: unknown) => `rejected: ${err instanceof Error ? err.message : String(err)}`,
    ),
    sleep(ms).then(() => 'never settled'),
  ])
}

test('a frame that is not an object is dropped, and the socket keeps working', async () => {
  const ws = await connectBridge('ses_primitives')
  const seen: string[] = []
  bridge.subscribeEvents('ses_primitives', (data) => seen.push(data))

  // `null` is the one JSON value that is not an object and still answers a
  // property read with a throw rather than undefined.
  for (const frame of ['null', '123', '"x"', 'true', '[]', '["type"]', 'nonsense']) {
    ws.send(frame)
  }
  ws.send(JSON.stringify({ type: 'event', data: 'still here' }))
  await sleep(200)

  expect(seen).toEqual(['still here'])
  expect(bridge.isConnected('ses_primitives')).toBe(true)
})

test('a response body too deep to re-serialize fails its own request only', async () => {
  const ws = await connectBridge('ses_deep')
  const victim = await connectBridge('ses_neighbour')

  const pending = bridge.request('ses_deep', { method: 'GET', path: '/session' }, 5000)
  const sent = await nextFrame(ws, 'proxy')
  // JSON.parse is iterative and JSON.stringify is not, so this parses and then
  // overflows the stack when the handler re-serializes it — 10 kB of '[' from
  // a bridge that legitimately holds this request_id.
  const deep = '['.repeat(5000) + ']'.repeat(5000)
  ws.send(`{"type":"proxy_response","request_id":${JSON.stringify(sent.request_id)},"status":200,"body":${deep}}`)

  expect(await outcome(pending)).toBe('rejected: bad proxy response')
  // The neighbour's bridge is untouched, and so is the hub's request table:
  // its next request still goes out and is still answered.
  const neighbour = bridge.request('ses_neighbour', { method: 'GET', path: '/session' }, 5000)
  const forwarded = await nextFrame(victim, 'proxy')
  victim.send(JSON.stringify({ type: 'proxy_response', request_id: forwarded.request_id, status: 200, body: 'ok' }))
  expect(await outcome(neighbour)).toBe('resolved')
})

test('a bridge that answers with a body it cannot serialize keeps its socket', async () => {
  const ws = await connectBridge('ses_again')
  const first = bridge.request('ses_again', { method: 'GET', path: '/session' }, 5000)
  const sent = await nextFrame(ws, 'proxy')
  const deep = '['.repeat(5000) + ']'.repeat(5000)
  ws.send(`{"type":"proxy_response","request_id":${JSON.stringify(sent.request_id)},"status":200,"body":${deep}}`)
  expect(await outcome(first)).toBe('rejected: bad proxy response')

  // The bad frame cost one request, not the link: the next one is answered.
  const second = bridge.request('ses_again', { method: 'GET', path: '/session' }, 5000)
  const again = await nextFrame(ws, 'proxy')
  ws.send(JSON.stringify({ type: 'proxy_response', request_id: again.request_id, status: 200, body: 'ok' }))
  expect(await outcome(second)).toBe('resolved')
})
