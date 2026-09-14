import { afterEach, beforeEach, expect, test } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import { viewerTokenFrom } from './helpers/viewer-token'
import { WebSocket } from 'ws'
import { createApp } from '../src/server'
import { Store } from '../src/store'
import { BridgeClient } from '../src/ws/bridge'

/**
 * A revoked viewer's stream must stop receiving events BEFORE it is ended.
 *
 * The heartbeat ends the stream of a viewer whose token no longer verifies,
 * but the subscription to the bridge's events was only dropped on the
 * request's 'close' — which comes after the response has flushed. For a slow
 * client that is seconds away, and any event arriving in between was written
 * to an ended response. Node reports that as an 'error' event on the response,
 * nothing listens for it, and an unhandled 'error' ends the process: the relay
 * and every live share on it went down because one viewer on a slow link was
 * evicted while the owner's model was writing.
 */

process.env.RELAY_SSE_HEARTBEAT_MS = '50'
process.env.ACTIVATE_FAIL_DELAY_MS = '0'
// The backlog this test builds is far past the per-viewer cap, which would drop
// the slow viewer before its revocation and skip the path under test. The cap
// has its own test (sse-backpressure.test.ts); lift it out of the way here.
process.env.RELAY_SSE_MAX_BUFFER_BYTES = String(1024 ** 3)

let relay: http.Server
let relayUrl: string
let store: Store

beforeEach(async () => {
  // Assembled like startServer, but with the store in hand so a revocation
  // can be triggered directly.
  store = new Store()
  relay = http.createServer()
  const bridge = new BridgeClient(relay, store)
  relay.on('request', createApp(store, bridge))
  relay.on('close', () => bridge.close())
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve))
  relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`
})

afterEach(async () => {
  relay.closeAllConnections()
  await new Promise((resolve) => relay.close(resolve))
})

test('an evicted viewer on a slow link does not take the relay down while events flow', async () => {
  const errors: unknown[] = []
  const onError = (err: unknown) => errors.push(err)
  process.on('uncaughtException', onError)

  const created = await request(relay).post('/api/sessions').send({ session_id: 'ses_slow', directory: '/work', title: 't' })
  expect(created.status).toBe(201)
  const { access_code, bridge_token } = created.body as { access_code: string; bridge_token: string }
  const first = await request(relay).post('/api/activate').send({ code: access_code, session_id: 'ses_slow' })
  const viewerToken = viewerTokenFrom(first)

  // The owner's bridge, streaming events as fast as a model writes.
  const bridge = new WebSocket(`${relayUrl.replace(/^http/, 'ws')}/bridge?session_id=ses_slow`, {
    headers: { 'x-bridge-token': bridge_token },
  })
  await new Promise((resolve, reject) => {
    bridge.once('open', resolve)
    bridge.once('error', reject)
  })
  const pad = 'x'.repeat(16 * 1024)
  const flood = setInterval(() => {
    if (bridge.readyState !== WebSocket.OPEN) return
    for (let i = 0; i < 8; i++) bridge.send(JSON.stringify({ type: 'event', data: JSON.stringify({ type: 'message.part.delta', pad }) }))
  }, 2)

  // A viewer whose connection reads nothing: the relay's writes back up, so
  // its response cannot finish flushing once ended.
  const slow = net.connect((relay.address() as AddressInfo).port, '127.0.0.1')
  await new Promise((resolve) => slow.once('connect', resolve))
  slow.write(`GET /event HTTP/1.1\r\nHost: x\r\nx-viewer-token: ${viewerToken}\r\n\r\n`)
  slow.pause()
  await new Promise((resolve) => setTimeout(resolve, 300)) // let the backlog build

  try {
    // Revoke the slow viewer (eviction, idle expiry and deleting the share
    // all reach the stream the same way: its token stops verifying).
    const verify = store.verifyViewer.bind(store)
    store.verifyViewer = (session_id, token) => token !== viewerToken && verify(session_id, token)

    // Several heartbeats: the stream is ended while events keep arriving.
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(errors).toEqual([])
    expect((await request(relay).get('/health')).status).toBe(200)
  } finally {
    clearInterval(flood)
    bridge.terminate()
    slow.destroy()
    process.off('uncaughtException', onError)
  }
}, 20_000)

test('unsubscribing twice never silences another viewer of the same share', async () => {
  // A stream now unsubscribes from both 'close' events. The second call used to
  // find its (empty, already removed) set and delete the session's entry — by
  // then possibly a NEW set belonging to a viewer who joined in between.
  const server = http.createServer()
  const hub = new BridgeClient(server, new Store())
  try {
    const seen: string[] = []
    const offA = hub.subscribeEvents('ses_shared', () => {})
    offA()
    const offB = hub.subscribeEvents('ses_shared', (data) => seen.push(data))
    offA() // A's second 'close'
    ;(hub as unknown as { onMessage(id: string, raw: Buffer): void }).onMessage(
      'ses_shared',
      Buffer.from(JSON.stringify({ type: 'event', data: 'still-here' })),
    )
    expect(seen).toEqual(['still-here'])
    offB()
  } finally {
    hub.close()
  }
})
