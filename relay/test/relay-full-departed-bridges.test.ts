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
 * What a share whose bridge connected once and then went away may hold on to
 * when the relay is full.
 *
 * RELAY_MAX_SESSIONS bounds the session set, and a full relay made room only
 * by dropping registrations no bridge had ever connected to. One WebSocket
 * handshake was enough to leave that rule: the connection clears the unbound
 * mark for good, and the session then kept its slot for the reaper's whole
 * day, with nothing connected. So 400 addresses (five active sessions each)
 * registered 2,000 sessions, opened and closed one bridge socket per
 * registration, and every new share on the relay got 503 "relay full" for a
 * day; one more handshake per session, from any host and without registering
 * again, renewed it for another. Before the cap existed there was no such
 * refusal at all.
 *
 * A connected bridge shows a sign of life at least every ping round (its pong,
 * or any byte it sends), so a share silent for minutes has no bridge. A full
 * relay now gives the slot of the one silent longest to the new registration,
 * with the same revocation the reaper applies. Holding a slot takes a bridge
 * that keeps answering, not one handshake a day.
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
  delete process.env.RELAY_WS_PING_INTERVAL_MS
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
  store.checkRegistrationLimit(ip, id)
  const created = store.createSession(id, '/work', 't', ip, owner_key)
  store.commitRegistration(ip)
  return created
}

test('a full relay gives the slot of the share whose bridge left longest ago to a new registration', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  process.env.RELAY_MAX_SESSIONS = '4'
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
    })
    return ws
  }
  /** A sign of life from a connected bridge, as its answers to the relay's pings are. */
  const showLife = async (ws: WebSocket) => {
    const pong = new Promise((resolve) => ws.once('pong', resolve))
    ws.ping()
    // The relay answered, so it has read the frame, and every byte it reads
    // from a bridge touches the session.
    await pong
  }

  // A live share, registered before everything else, whose bridge stays.
  const live = await post('ses_live', '198.51.100.1')
  expect(live.status).toBe(201)
  const liveWs = await dial('ses_live', live.body.bridge_token)

  // Three shares whose bridge connected once and left, a minute apart.
  const tokens = new Map<string, string>()
  for (const [id, ip] of [
    ['ses_gone0', '198.51.100.1'],
    ['ses_gone1', '198.51.100.2'],
    ['ses_gone2', '198.51.100.2'],
  ] as const) {
    vi.setSystemTime(Date.now() + MINUTE)
    const res = await post(id, ip)
    expect(res.status).toBe(201)
    tokens.set(id, res.body.bridge_token)
    const ws = await dial(id, res.body.bridge_token)
    ws.close()
    await new Promise((resolve) => ws.once('close', resolve))
    expect(bridge.isConnected(id)).toBe(false)
  }
  expect(store.sessionCount()).toBe(4)

  // A bridge that left moments ago may be re-dialling: nobody's slot is taken yet.
  vi.setSystemTime(Date.now() + 30_000)
  await showLife(liveWs)
  expect((await post('ses_new0', '203.0.113.1')).status).toBe(503)

  vi.setSystemTime(Date.now() + LONG_AFTER)
  await showLife(liveWs)
  const next = await post('ses_new0', '203.0.113.1')
  expect(next.status).toBe(201)
  // Exactly one slot, the one whose bridge has been silent longest.
  expect(store.getSession('ses_gone0')).toBeUndefined()
  expect(store.getSession('ses_gone1')).toBeDefined()
  expect(store.getSession('ses_gone2')).toBeDefined()
  expect(store.sessionCount()).toBe(4)
  // Its token is gone with it: that bridge cannot come back into a slot it lost.
  expect(store.verifyBridgeToken('ses_gone0', tokens.get('ses_gone0')!)).toBe(false)
  // The share with a bridge is untouched, however long ago it registered.
  expect(store.getSession('ses_live')).toBeDefined()
  expect(bridge.isConnected('ses_live')).toBe(true)

  // The next ones take the next longest-silent slots, in order...
  expect((await post('ses_new1', '203.0.113.2')).status).toBe(201)
  expect(store.getSession('ses_gone1')).toBeUndefined()
  expect((await post('ses_new2', '203.0.113.3')).status).toBe(201)
  expect(store.getSession('ses_gone2')).toBeUndefined()
  // ...and once only a live share and fresh registrations are left, the relay
  // is full again.
  expect((await post('ses_new3', '203.0.113.4')).status).toBe(503)
  expect(store.getSession('ses_live')).toBeDefined()
  expect(store.sessionCount()).toBe(4)
})

test("an evicted share ends like a reaped one: viewers revoked, streams told, the id kept for its owner", () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  process.env.RELAY_MAX_SESSIONS = '2'
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const store = new Store()
  const ended: string[] = []
  store.onRegistrationEnd((id) => ended.push(id))
  const owner = 'k'.repeat(43)
  const gone = register(store, 'ses_gone', '198.51.100.1', owner)
  // What the bridge hub calls when the bridge connects.
  store.touchSession('ses_gone')
  const { viewer_token } = store.activate(gone.access_code, 'ses_gone')
  vi.setSystemTime(Date.now() + MINUTE)
  register(store, 'ses_quiet', '198.51.100.2')
  store.touchSession('ses_quiet')

  vi.setSystemTime(Date.now() + LONG_AFTER)
  // The periodic reaper still gives both their day...
  expect(store.reapOrphans(config.orphanReapMs)).toEqual([])
  // ...but a registration that finds the relay full takes the longest-silent slot.
  expect(() => register(store, 'ses_next', '203.0.113.1')).not.toThrow()
  expect(ended).toEqual(['ses_gone'])
  // A busy relay no longer refuses anyone, so the eviction is what tells the
  // operator which limit was hit.
  expect(warn.mock.calls.flat().join(' ')).toMatch(/ses_gone.*RELAY_MAX_SESSIONS/)
  expect(store.getSession('ses_quiet')).toBeDefined()
  expect(store.getSessionByViewerToken(viewer_token)).toBeUndefined()
  // Anyone holding the old link cannot take the id the owner will share again.
  expect(() => store.createSession('ses_gone', '/work', 't', '203.0.113.66')).toThrow('session reserved')
})

test('after a restart a restored share gets the time to re-dial before a full relay may take its slot', () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  process.env.RELAY_MAX_SESSIONS = '1'
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const store = new Store()
  register(store, 'ses_restored', '198.51.100.1')
  store.touchSession('ses_restored')
  const saved = store.snapshot()

  // The relay was down long enough that last_seen in the file is old.
  vi.setSystemTime(Date.now() + LONG_AFTER)
  const restarted = new Store()
  expect(restarted.restore(saved)).toBe(1)
  // Its bridge was connected to the old process and is on its way back.
  vi.setSystemTime(Date.now() + MINUTE)
  expect(() => register(restarted, 'ses_next', '203.0.113.1')).toThrow('relay full')

  // It had its chance, and did not come back.
  vi.setSystemTime(Date.now() + LONG_AFTER)
  expect(() => register(restarted, 'ses_next', '203.0.113.1')).not.toThrow()
  expect(restarted.getSession('ses_restored')).toBeUndefined()
})

test('a full relay never takes the slot of a bridge that is still inside its ping rounds', () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  process.env.RELAY_MAX_SESSIONS = '1'
  // An operator who pings rarely: a connected, idle bridge shows life only this often.
  process.env.RELAY_WS_PING_INTERVAL_MS = String(20 * MINUTE)
  const store = new Store()
  register(store, 'ses_idle', '198.51.100.1')
  store.touchSession('ses_idle')

  vi.setSystemTime(Date.now() + LONG_AFTER)
  expect(() => register(store, 'ses_next', '203.0.113.1')).toThrow('relay full')
  expect(store.getSession('ses_idle')).toBeDefined()
})
