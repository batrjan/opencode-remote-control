import { afterEach, beforeEach, expect, test } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { Store } from '../src/store'
import { BridgeClient } from '../src/ws/bridge'

/**
 * The bridge_token authenticates the /bridge upgrade and is long-lived. It must
 * travel only in the x-bridge-token header, never in the URL query: a token in
 * ?token= lands in nginx access logs and any proxy log along the way, where a
 * long-lived control credential does not belong. The real bridge already sends
 * the header (bridge/src/relay.ts), so the query form only ever served an
 * attacker leaking the token into logs — these tests pin that the query form is
 * refused at the upgrade while the header keeps working.
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

function register(session_id: string) {
  return store.createSession(session_id, `/tmp/${session_id}`, session_id, '127.0.0.1')
}

test('a bridge token in the URL query is refused at the upgrade', async () => {
  const a = register('sess-a')
  // A valid token, but presented only in ?token= — the very thing that would
  // leak it into access logs. No header at all: the upgrade must fail (401).
  await expect(
    new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(
        `${wsBase}?session_id=${encodeURIComponent('sess-a')}&token=${encodeURIComponent(a.bridge_token)}`,
      )
      ws.once('open', () => resolve(ws))
      ws.once('error', reject)
    }),
  ).rejects.toThrow(/401|Unexpected server response/)
})

test('the same token in the x-bridge-token header still connects', async () => {
  const a = register('sess-a')
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const sock = new WebSocket(`${wsBase}?session_id=${encodeURIComponent('sess-a')}`, {
      headers: { 'x-bridge-token': a.bridge_token },
    })
    sock.once('open', () => resolve(sock))
    sock.once('error', reject)
  })
  expect(ws.readyState).toBe(WebSocket.OPEN)
  ws.terminate()
})
