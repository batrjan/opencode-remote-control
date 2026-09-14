import { afterEach, expect, test, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import { WebSocket } from 'ws'
import { createApp } from '../src/server'
import { Store } from '../src/store'
import { config } from '../src/config'
import { BridgeClient } from '../src/ws/bridge'

/**
 * What keeps a share's slot on a full relay, and who may make a full relay
 * give one up.
 *
 * A full relay gives a new registration the slot of the share whose bridge has
 * been silent longest (see Store.evictDepartedShare). It ranked by last_seen,
 * and a bridge connection touches last_seen the moment it opens. So nobody had
 * to keep a bridge: one handshake (connect, close) per session every five
 * minutes, about 7 a second for 2,000 sessions from any single host, kept an
 * attacker's sessions "seen" — and the share that lost its slot instead was an
 * honest one whose laptop had gone to sleep. Its bridge was then refused with
 * 401, which ends the share, and its viewers needed a new code. Worse, the
 * eviction ran before the per-address checks and the owner_key reservation, so
 * a request that was then refused with 429 or 409 had already ended someone
 * else's share.
 */

const MINUTE = 60_000
/** Well past any re-dial after a network blip, far inside the day the reaper allows. */
const LONG_AFTER = 30 * MINUTE

let server: http.Server | undefined
let bridge: BridgeClient | undefined
const sockets: WebSocket[] = []

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete process.env.RELAY_MAX_SESSIONS
  for (const ws of sockets.splice(0)) ws.terminate()
  bridge?.close()
  bridge = undefined
  if (server) {
    server.closeAllConnections()
    await new Promise((resolve) => server!.close(resolve))
    server = undefined
  }
})

/** Registers the way the session API does: check, create, then commit the slot. */
function register(store: Store, id: string, ip: string, owner_key?: string) {
  store.checkRegistrationLimit(ip, id, owner_key)
  const created = store.createSession(id, '/work', 't', ip, owner_key)
  store.commitRegistration(ip)
  return created
}

test('a bridge handshake repeated without staying connected does not keep a slot a sleeping share loses', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  process.env.RELAY_MAX_SESSIONS = '3'
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const store = new Store()
  server = http.createServer()
  bridge = new BridgeClient(server, store)
  server.on('request', createApp(store, bridge))
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const post = (session_id: string, ip: string) =>
    request(`http://127.0.0.1:${port}`)
      .post('/api/sessions')
      .set('X-Forwarded-For', ip)
      .send({ session_id, directory: '/work', title: 't' })
  const dial = async (session_id: string, token: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge?session_id=${session_id}`, {
      headers: { 'x-bridge-token': token },
    })
    sockets.push(ws)
    // The relay's hello is sent from its connection handler, so by now the
    // connection has touched the session.
    await new Promise((resolve, reject) => {
      ws.once('message', resolve)
      ws.once('error', reject)
      ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)))
    })
    return ws
  }
  const hangUp = async (ws: WebSocket) => {
    ws.close()
    await new Promise((resolve) => ws.once('close', resolve))
  }
  /** Bytes from the bridge, answered: the relay has read them, and every byte it reads is a sign of life. */
  const showLife = async (ws: WebSocket) => {
    const pong = new Promise((resolve) => ws.once('pong', resolve))
    ws.ping()
    await pong
  }
  /** Connect, say something, leave: all it takes to "see" a session without keeping a bridge. */
  const handshake = async (session_id: string, token: string) => {
    const ws = await dial(session_id, token)
    await showLife(ws)
    await hangUp(ws)
  }

  // An honest share, registered first, whose bridge connects and stays.
  const honest = await post('ses_honest', '203.0.113.9')
  expect(honest.status).toBe(201)
  const honestWs = await dial('ses_honest', honest.body.bridge_token)

  // The attacker's sessions, registered later: never more than a handshake.
  vi.setSystemTime(Date.now() + MINUTE)
  const attacker = new Map<string, string>()
  for (const id of ['ses_atk0', 'ses_atk1']) {
    const res = await post(id, '198.51.100.7')
    expect(res.status).toBe(201)
    attacker.set(id, res.body.bridge_token)
    await handshake(id, res.body.bridge_token)
  }

  // The honest bridge answers, minutes into its connection, until the owner's
  // laptop goes to sleep.
  vi.setSystemTime(Date.now() + 2 * MINUTE)
  await showLife(honestWs)
  await hangUp(honestWs)

  // Past departedBridgeMs, the attacker renews both sessions by handshake.
  vi.setSystemTime(Date.now() + 6 * MINUTE)
  for (const [id, token] of attacker) await handshake(id, token)

  // New shares take the slots of the sessions no bridge stayed with, not the
  // sleeping share's, though it registered first and was last touched longest
  // ago.
  expect((await post('ses_new0', '192.0.2.1')).status).toBe(201)
  expect(store.getSession('ses_honest')).toBeDefined()
  expect(store.getSession('ses_atk0')).toBeUndefined()
  expect((await post('ses_new1', '192.0.2.2')).status).toBe(201)
  expect(store.getSession('ses_honest')).toBeDefined()
  expect(store.getSession('ses_atk1')).toBeUndefined()

  // The laptop wakes: its bridge gets back in.
  const woken = await dial('ses_honest', honest.body.bridge_token)
  expect(bridge.isConnected('ses_honest')).toBe(true)
  // A connected bridge keeps its slot even before it has been back a ping
  // round, and the other two are fresh registrations still dialling.
  expect((await post('ses_new2', '192.0.2.3')).status).toBe(503)
  expect(store.getSession('ses_honest')).toBeDefined()
  woken.terminate()
})

/**
 * A full relay (one slot) holding a share whose bridge left long ago, an
 * address that has used up its hour of registrations, and an id reserved for
 * the install that shared it.
 */
function fullRelayWithDepartedShare() {
  vi.useFakeTimers({ toFake: ['Date'] })
  process.env.RELAY_MAX_SESSIONS = '1'
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const store = new Store()
  const app = createApp(store)
  const post = (session_id: string, ip: string, owner_key?: string) =>
    request(app)
      .post('/api/sessions')
      .set('X-Forwarded-For', ip)
      .send({ session_id, directory: '/work', title: 't', ...(owner_key ? { owner_key } : {}) })
  const busy = '198.51.100.20'
  for (let i = 0; i < config.registrationsPerWindow; i++) {
    register(store, `ses_hour${i}`, busy)
    store.deleteSession(`ses_hour${i}`)
  }
  register(store, 'ses_claimed', '198.51.100.30', 'k'.repeat(43))
  store.deleteSession('ses_claimed')
  register(store, 'ses_gone', '203.0.113.1')
  // What the bridge hub calls when the bridge connects.
  store.touchSession('ses_gone')
  vi.setSystemTime(Date.now() + LONG_AFTER)
  const ended = () => warn.mock.calls.flat().join(' ').includes('ended share')
  return { store, post, busy, ended }
}

test('a registration refused for its address (429) ends nobody else\'s share', async () => {
  const { store, post, busy, ended } = fullRelayWithDepartedShare()
  expect((await post('ses_busy_next', busy)).status).toBe(429)
  expect(store.getSession('ses_gone')).toBeDefined()
  expect(ended()).toBe(false)

  // A registration that does go through still gets the departed share's slot.
  expect((await post('ses_next', '192.0.2.1')).status).toBe(201)
  expect(store.getSession('ses_gone')).toBeUndefined()
})

test('a registration refused for a reserved id (409) ends nobody else\'s share', async () => {
  const { store, post, ended } = fullRelayWithDepartedShare()
  expect((await post('ses_claimed', '203.0.113.66', 'x'.repeat(43))).status).toBe(409)
  expect((await post('ses_claimed', '203.0.113.67')).status).toBe(409)
  expect(store.getSession('ses_gone')).toBeDefined()
  expect(ended()).toBe(false)

  // Its owner, back with the key, does get the departed share's slot.
  expect((await post('ses_claimed', '203.0.113.68', 'k'.repeat(43))).status).toBe(201)
  expect(store.getSession('ses_gone')).toBeUndefined()
})
