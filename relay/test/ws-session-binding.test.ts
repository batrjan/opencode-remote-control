import { afterEach, beforeEach, expect, test } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { Store } from '../src/store'
import { BridgeClient } from '../src/ws/bridge'

/**
 * Session binding in the bridge hub. Two shares are two mutually distrusting
 * tenants on one relay: each bridge authenticates for exactly one session, and
 * nothing it sends may touch another session's state. The pending-request
 * table is the only structure in the hub keyed by something other than the
 * session id (the request_id), so it is the only place where one tenant's
 * socket can reach another tenant's data — these tests pin that boundary.
 *
 * The harness is the real hub over a real HTTP server with a real Store, i.e.
 * exactly what startServer() wires up, minus the express app: the tests need
 * the BridgeClient instance itself to observe in-flight requests.
 */

let server: http.Server
let store: Store
let bridge: BridgeClient
let wsBase: string

beforeEach(async () => {
  store = new Store()
  server = http.createServer((_req, res) => res.end())
  bridge = new BridgeClient(server, store)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  wsBase = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/bridge`
})

afterEach(async () => {
  bridge.close()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
})

function connectBridge(session_id: string, token: string): Promise<WebSocket> {
  const ws = new WebSocket(`${wsBase}?session_id=${encodeURIComponent(session_id)}`, {
    headers: { 'x-bridge-token': token },
  })
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

/** Resolve with the request_id of the next `proxy` frame this bridge is sent. */
function nextProxyRequestId(ws: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    const onMessage = (raw: WebSocket.RawData) => {
      const msg = JSON.parse(String(raw)) as { type?: string; request_id?: string }
      if (msg.type !== 'proxy' || typeof msg.request_id !== 'string') return
      ws.off('message', onMessage)
      resolve(msg.request_id)
    }
    ws.on('message', onMessage)
  })
}

/**
 * Wait until the hub has processed everything `ws` has sent so far. Frames on
 * one socket are handled in order, so a full round trip over that same socket
 * proves the earlier (forged) frame was already seen — no sleep-and-hope.
 */
async function barrier(session_id: string, ws: WebSocket): Promise<void> {
  const id = nextProxyRequestId(ws)
  const done = bridge.request(session_id, { method: 'GET', path: '/barrier' }, 5000)
  ws.send(JSON.stringify({ type: 'proxy_response', request_id: await id, status: 200, body: '{}' }))
  await done
}

/** Has this promise settled yet? (Never awaits it to completion.) */
function settled<T>(p: Promise<T>): Promise<boolean> {
  let done = false
  p.then(
    () => (done = true),
    () => (done = true),
  )
  return new Promise((resolve) => setImmediate(() => resolve(done)))
}

function register(session_id: string) {
  return store.createSession(session_id, `/tmp/${session_id}`, session_id, '127.0.0.1')
}

test("a bridge cannot resolve another session's in-flight proxy request", async () => {
  const a = register('sess-a')
  const b = register('sess-b')
  const wsA = await connectBridge('sess-a', a.bridge_token)
  const wsB = await connectBridge('sess-b', b.bridge_token)

  // B's bridge learns the request id but deliberately holds its answer back.
  const idB = nextProxyRequestId(wsB)
  const inFlight = bridge.request('sess-b', { method: 'GET', path: '/session/sess-b/message' }, 5000)
  const request_id = await idB

  // A's socket — authenticated for sess-a only — answers B's request.
  wsA.send(
    JSON.stringify({
      type: 'proxy_response',
      request_id,
      status: 200,
      contentType: 'application/json',
      body: '{"poisoned":true}',
    }),
  )
  await barrier('sess-a', wsA) // the forged frame has now been processed

  expect(await settled(inFlight)).toBe(false)

  // The pending entry must also have survived: only B's own bridge may answer,
  // and it still can.
  wsB.send(JSON.stringify({ type: 'proxy_response', request_id, status: 200, body: '{"ok":true}' }))
  await expect(inFlight).resolves.toMatchObject({ status: 200, body: '{"ok":true}' })

  wsA.terminate()
  wsB.terminate()
})

test("a forged cross-session response does not stop the victim's own timeout", async () => {
  const a = register('sess-a')
  const b = register('sess-b')
  const wsA = await connectBridge('sess-a', a.bridge_token)
  const wsB = await connectBridge('sess-b', b.bridge_token)

  const idB = nextProxyRequestId(wsB)
  const inFlight = bridge.request('sess-b', { method: 'GET', path: '/session/sess-b/message' }, 250)
  const request_id = await idB
  wsA.send(JSON.stringify({ type: 'proxy_response', request_id, status: 200, body: '{"poisoned":true}' }))

  // B's bridge never answers: the viewer must get the honest timeout (a 504
  // upstream), never A's body and never a silently swallowed request.
  await expect(inFlight).rejects.toThrow('proxy timeout')

  wsA.terminate()
  wsB.terminate()
})

test('the same-session path still resolves normally, status and content type included', async () => {
  const a = register('sess-a')
  const wsA = await connectBridge('sess-a', a.bridge_token)

  const id = nextProxyRequestId(wsA)
  const inFlight = bridge.request('sess-a', { method: 'GET', path: '/session/sess-a/message' }, 5000)
  wsA.send(
    JSON.stringify({
      type: 'proxy_response',
      request_id: await id,
      status: 201,
      contentType: 'text/plain',
      body: 'hello',
    }),
  )
  await expect(inFlight).resolves.toEqual({ status: 201, contentType: 'text/plain', body: 'hello' })

  wsA.terminate()
})

test('two sessions answer their own concurrent requests, unaffected by each other', async () => {
  const a = register('sess-a')
  const b = register('sess-b')
  const wsA = await connectBridge('sess-a', a.bridge_token)
  const wsB = await connectBridge('sess-b', b.bridge_token)

  const idA = nextProxyRequestId(wsA)
  const idB = nextProxyRequestId(wsB)
  const reqA = bridge.request('sess-a', { method: 'GET', path: '/a' }, 5000)
  const reqB = bridge.request('sess-b', { method: 'GET', path: '/b' }, 5000)

  // Answer out of order, each on its own socket.
  wsB.send(JSON.stringify({ type: 'proxy_response', request_id: await idB, status: 200, body: 'B' }))
  wsA.send(JSON.stringify({ type: 'proxy_response', request_id: await idA, status: 200, body: 'A' }))

  expect((await reqA).body).toBe('A')
  expect((await reqB).body).toBe('B')

  wsA.terminate()
  wsB.terminate()
})

test("events from one bridge never reach another session's listeners", async () => {
  const a = register('sess-a')
  const b = register('sess-b')
  const wsA = await connectBridge('sess-a', a.bridge_token)
  const wsB = await connectBridge('sess-b', b.bridge_token)

  const seenA: string[] = []
  const seenB: string[] = []
  // '' is the bucket a session-less socket would fall into; nothing may land
  // there either.
  const seenBlank: string[] = []
  const offA = bridge.subscribeEvents('sess-a', (d) => seenA.push(d))
  const offB = bridge.subscribeEvents('sess-b', (d) => seenB.push(d))
  const offBlank = bridge.subscribeEvents('', (d) => seenBlank.push(d))

  wsA.send(JSON.stringify({ type: 'event', data: '{"from":"a"}' }))
  await barrier('sess-a', wsA)

  expect(seenA).toEqual(['{"from":"a"}'])
  expect(seenB).toEqual([])
  expect(seenBlank).toEqual([])

  offA()
  offB()
  offBlank()
  wsA.terminate()
  wsB.terminate()
})

test('a bridge socket without a session id is refused at the upgrade', async () => {
  const a = register('sess-a')
  const seenBlank: string[] = []
  const off = bridge.subscribeEvents('', (d) => seenBlank.push(d))

  // No session id at all, and a real token from another session: the upgrade
  // must fail, so no socket ever exists to route an event from.
  await expect(
    new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(wsBase, { headers: { 'x-bridge-token': a.bridge_token } })
      ws.once('open', () => resolve(ws))
      ws.once('error', reject)
    }),
  ).rejects.toThrow(/401|Unexpected server response/)

  expect(seenBlank).toEqual([])
  off()
})
