import { afterEach, expect, test, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import { WebSocket } from 'ws'
import { createApp } from '../src/server'
import { Store } from '../src/store'
import { config } from '../src/config'
import { BridgeClient } from '../src/ws/bridge'
import type { PersistedState } from '../src/persist'

/**
 * What a registration no bridge ever took up may hold on to.
 *
 * RELAY_MAX_SESSIONS bounds the session set, and until a session was reaped it
 * held its slot. The reaper looked only at last_seen, so a registration whose
 * bridge never connected lived as long as an abandoned share: a day. Five
 * active sessions per address made that a cheap denial of service: 400
 * addresses (twelve registrations an hour each) filled a 2,000-session relay
 * inside an hour with nothing but POSTs, and every new share after that got
 * 503 "relay full" for the rest of the day, renewable at will.
 *
 * A real bridge dials the relay the moment its registration comes back, and
 * deletes the registration if that dial fails (bridge/src/index.ts start()),
 * so a registration nobody connected to within minutes is not a share anyone
 * is waiting on. It no longer keeps a slot: the reaper drops it, and so does a
 * full relay that needs the room, before refusing anyone.
 */

const MINUTE = 60_000
/** Far past the moment a real bridge dials in, far inside the day the reaper allows a share. */
const LONG_AFTER = 30 * MINUTE
/** A bridge may still be dialling this long after registering (its handshake alone may take 15 s). */
const STILL_DIALLING = 30_000

let server: http.Server | undefined
let bridge: BridgeClient | undefined
const sockets: WebSocket[] = []

afterEach(async () => {
  vi.useRealTimers()
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
function register(store: Store, id: string, ip: string) {
  store.checkRegistrationLimit(ip, id)
  const created = store.createSession(id, '/work', 't', ip)
  store.commitRegistration(ip)
  return created
}

test('a full relay makes room by dropping registrations no bridge ever connected to', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  process.env.RELAY_MAX_SESSIONS = '2'
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

  // A live share: registered, and its bridge connected right away.
  const live = await post('ses_live', '203.0.113.1')
  expect(live.status).toBe(201)
  const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge?session_id=ses_live`, {
    headers: { 'x-bridge-token': live.body.bridge_token },
  })
  sockets.push(ws)
  // The relay's hello is sent from its connection handler, so by now it ran.
  await new Promise((resolve, reject) => {
    ws.once('message', resolve)
    ws.once('error', reject)
  })

  // A registration whose bridge never dialled in.
  expect((await post('ses_never_bridged', '203.0.113.2')).status).toBe(201)

  // Inside its dial window it still holds its slot: the relay stays full.
  vi.setSystemTime(Date.now() + STILL_DIALLING)
  expect((await post('ses_too_soon', '203.0.113.3')).status).toBe(503)

  vi.setSystemTime(Date.now() + LONG_AFTER)
  const next = await post('ses_next', '203.0.113.3')
  expect(next.status).toBe(201)
  expect(store.getSession('ses_never_bridged')).toBeUndefined()
  // The share with a bridge is untouched, however long ago it registered.
  expect(store.getSession('ses_live')).toBeDefined()
  expect(bridge.isConnected('ses_live')).toBe(true)
  expect(store.sessionCount()).toBe(2)
})

test('the reaper drops a registration no bridge connected to without waiting a day', () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const store = new Store()
  register(store, 'ses_never_bridged', '198.51.100.1')
  register(store, 'ses_bridged', '198.51.100.2')
  // What the bridge hub calls on a connection and on every sign of life after.
  store.touchSession('ses_bridged')

  vi.setSystemTime(Date.now() + STILL_DIALLING)
  expect(store.reapOrphans(config.orphanReapMs)).toEqual([])

  vi.setSystemTime(Date.now() + LONG_AFTER)
  expect(store.reapOrphans(config.orphanReapMs)).toEqual(['ses_never_bridged'])
  // A share whose bridge is merely quiet keeps the day it always had.
  expect(store.getSession('ses_bridged')).toBeDefined()
})

test('a restart gives a never-bridged registration its window again, and keeps a share that had a bridge', () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const store = new Store()
  let saved: PersistedState | undefined
  store.setChangeListener(() => {
    saved = store.snapshot()
  })
  register(store, 'ses_never_bridged', '198.51.100.1')
  register(store, 'ses_bridged', '198.51.100.2')
  store.touchSession('ses_bridged')

  // The relay was down longer than the dial window.
  vi.setSystemTime(Date.now() + LONG_AFTER)
  const restarted = new Store()
  expect(restarted.restore(saved)).toBe(2)
  // Counted from the restart, not from the registration: nothing in the file
  // says how long ago this process could first have been reached.
  expect(restarted.reapOrphans(config.orphanReapMs)).toEqual([])

  vi.setSystemTime(Date.now() + LONG_AFTER)
  expect(restarted.reapOrphans(config.orphanReapMs)).toEqual(['ses_never_bridged'])
  // Nothing in the file marks a bridge that has since connected as missing.
  expect(restarted.getSession('ses_bridged')).toBeDefined()
})

test('a state file from a relay that did not track bridges keeps every share for its day', () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const store = new Store()
  register(store, 'ses_old_file', '198.51.100.1')
  const saved = store.snapshot()
  // The mark this relay writes for a registration no bridge has connected to...
  expect(saved.sessions[0]).toHaveProperty('unbound', true)
  // ...which an older relay never wrote.
  for (const s of saved.sessions) delete (s as { unbound?: unknown }).unbound

  const restarted = new Store()
  expect(restarted.restore(saved)).toBe(1)
  vi.setSystemTime(Date.now() + LONG_AFTER)
  // Its bridge may well be connected to the old process and re-dialling this
  // one: taking it for a registration nobody took up would end a live share.
  expect(restarted.reapOrphans(config.orphanReapMs)).toEqual([])
  expect(restarted.getSession('ses_old_file')).toBeDefined()
})
