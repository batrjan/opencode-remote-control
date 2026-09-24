import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import request from 'supertest'
import { createApp } from '../src/server'
import { Store } from '../src/store'
import { config } from '../src/config'
import type { PersistedSession, PersistedState } from '../src/persist'
import { FileStateStore, STATE_VERSION, stateKey } from '../src/persist'

/**
 * How much state public registration can make the relay hold, and what holding
 * it costs everyone else.
 *
 * Registration is public and was capped only per client address (five active
 * sessions, twelve an hour). Nothing bounded the total, so a pool of addresses
 * (a botnet, a residential proxy service) could lodge sessions without end:
 * 400 addresses made 2,000 sessions, 3,000 made 15,000, each carrying up to a
 * 4 KB directory and a 1 KB title. That state then hurt every other share
 * twice over:
 *
 * - Every change to the session set rewrote the WHOLE set to the state file,
 *   and the write was synchronous: build the snapshot, JSON-encode it, AES
 *   encrypt it and writeFileSync it, all on the event loop. At 10,000 sessions
 *   that is a 75 MB file and ~350 ms in which the relay serves nothing — no
 *   viewer request, no SSE heartbeat, no bridge pong — repeated after every
 *   debounced change.
 * - The per-address registration counters were a plain Map with one entry per
 *   address ever seen, created even for a registration that was then refused,
 *   and never removed: not when the sessions ended, not when the hour was up.
 *   Unlike every sibling tracking map it had no size cap either.
 */

const KEY = randomBytes(32).toString('hex')

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'relay-bounds-'))
  file = path.join(dir, 'state', 'sessions.json')
})

afterEach(() => {
  vi.useRealTimers()
  delete process.env.RELAY_MAX_SESSIONS
  rmSync(dir, { recursive: true, force: true })
})

/** Registers the way the session API does: check, create, then commit the slot. */
function register(store: Store, id: string, ip: string) {
  store.checkRegistrationLimit(ip, id)
  const created = store.createSession(id, '/work', 't', ip)
  store.commitRegistration(ip)
  return created
}

test('the relay holds at most RELAY_MAX_SESSIONS sessions, however many addresses register', () => {
  process.env.RELAY_MAX_SESSIONS = '3'
  const store = new Store()
  for (let i = 0; i < 3; i++) register(store, `ses_cap${i}`, `203.0.113.${i + 1}`)

  // A fresh address, well inside every per-address limit, is still refused.
  expect(() => register(store, 'ses_cap3', '203.0.113.99')).toThrow('relay full')
  expect(store.sessionCount()).toBe(3)

  // An ending share frees its slot for the next registration.
  store.deleteSession('ses_cap0')
  expect(() => register(store, 'ses_cap3', '203.0.113.99')).not.toThrow()
  expect(() => register(store, 'ses_cap4', '203.0.113.100')).toThrow('relay full')
})

test('a full relay still lets an owner re-register the id it already holds', () => {
  // Replacing a live registration (its bridge died without a word) does not
  // grow the set, and refusing it would leave the owner locked out of their
  // own share until the reaper removed the stale one a day later.
  process.env.RELAY_MAX_SESSIONS = '2'
  const store = new Store()
  const owner = 'k'.repeat(43)
  store.checkRegistrationLimit('198.51.100.1', 'ses_mine')
  store.createSession('ses_mine', '/work', 't', '198.51.100.1', owner)
  store.commitRegistration('198.51.100.1')
  register(store, 'ses_other', '198.51.100.2')

  expect(() => store.checkRegistrationLimit('198.51.100.1', 'ses_mine')).not.toThrow()
  expect(store.createSession('ses_mine', '/work', 't', '198.51.100.1', owner).replaced).toBe(true)
  expect(store.sessionCount()).toBe(2)
})

test('POST /api/sessions answers a full relay with 503, not a per-address 429', async () => {
  process.env.RELAY_MAX_SESSIONS = '2'
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const store = new Store()
  const app = createApp(store)
  const statuses: number[] = []
  for (let i = 0; i < 3; i++) {
    const res = await request(app)
      .post('/api/sessions')
      .set('X-Forwarded-For', `203.0.113.${i + 1}`)
      .send({ session_id: `ses_http_cap${i}`, directory: '/work', title: 't' })
    statuses.push(res.status)
    if (res.status === 503) expect(res.body.error).toBe('relay full')
  }
  expect(statuses).toEqual([201, 201, 503])
  expect(store.sessionCount()).toBe(2)
  // The operator is told which limit was hit, so a relay that is simply busy
  // can be given a higher one.
  expect(warn.mock.calls.flat().join(' ')).toContain('RELAY_MAX_SESSIONS')
  warn.mockRestore()
})

test('registration counters stay bounded and are dropped once their hour is over', () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const store = new Store(10)
  const registrations = () => (store as unknown as { registrations: Map<string, unknown> }).registrations.size

  // A refused or conflicting registration commits nothing, so checking alone
  // must not leave a counter behind.
  for (let i = 0; i < 50; i++) store.checkRegistrationLimit(`192.0.2.${i}`, 'ses_probe')
  expect(registrations()).toBe(0)

  for (let i = 0; i < 1000; i++) {
    const ip = `10.${(i >> 8) & 255}.${i & 255}.1`
    register(store, `ses_many${i}`, ip)
    store.deleteSession(`ses_many${i}`)
  }
  // Capped like codeFails / sessionFails, not one entry per address ever seen.
  expect(registrations()).toBeLessThanOrEqual(10)

  // Once the window has passed the counters mean nothing: the periodic sweep
  // drops them rather than holding them forever.
  vi.setSystemTime(Date.now() + config.registrationWindowMs + 1000)
  store.reapOrphans(config.orphanReapMs)
  expect(registrations()).toBe(0)
})

test('the hourly per-address cap still counts across the bounded map', () => {
  const store = new Store(10)
  const ip = '198.51.100.20'
  for (let i = 0; i < config.registrationsPerWindow; i++) {
    register(store, `ses_hour${i}`, ip)
    store.deleteSession(`ses_hour${i}`) // keep the active cap out of play
  }
  expect(() => store.checkRegistrationLimit(ip, 'ses_hour_next')).toThrow('rate limited')
})

/** A session with every field at the length public registration allows. */
function bigSession(i: number, directory: string, title: string): PersistedSession {
  return {
    id: `ses_big_${i}`,
    directory,
    title,
    code_hash: 'c'.repeat(64),
    code_salt: 's'.repeat(32),
    bridge_token_hash: 'b'.repeat(64),
    bridge_token_salt: 't'.repeat(32),
    created_at: 1,
    last_seen: Date.now(),
    status: 'active',
    created_by_ip: '203.0.113.1',
    viewers: [],
  }
}

function bigState(count: number): PersistedState {
  const directory = '/'.padEnd(4096, 'd')
  const title = 'T'.padEnd(1024, 't')
  return {
    version: STATE_VERSION,
    saved_at: Date.now(),
    sessions: Array.from({ length: count }, (_, i) => bigSession(i, directory, title)),
    claims: [],
  }
}

/** Longest gap between ticks of a 5 ms interval while `until` stays false. */
async function worstLag(until: () => boolean, deadlineMs: number): Promise<number> {
  let worst = 0
  let last = performance.now()
  const started = last
  await new Promise<void>((resolve, reject) => {
    const tick = setInterval(() => {
      const now = performance.now()
      worst = Math.max(worst, now - last)
      last = now
      if (until()) {
        clearInterval(tick)
        resolve()
      } else if (now - started > deadlineMs) {
        clearInterval(tick)
        reject(new Error('state file never written'))
      }
    }, 5)
  })
  return worst
}

test('writing a large state file does not stall the event loop', async () => {
  const state = bigState(10_000)
  const write = new FileStateStore(file, 0, stateKey({ RELAY_STATE_KEY: KEY } as NodeJS.ProcessEnv))
  write.schedule(() => state)

  const lag = await worstLag(() => existsSync(file), 30_000)
  // A synchronous whole-file write held the loop for a few hundred ms here, and
  // everything else the relay does waited that long with it. Written a slice
  // per turn, the worst gap is around 10 ms.
  expect(lag).toBeLessThan(100)

  // ...and what was written is still the complete, loadable state.
  const loaded = new FileStateStore(file, 0, stateKey({ RELAY_STATE_KEY: KEY } as NodeJS.ProcessEnv)).load()
  expect(loaded?.sessions.length).toBe(10_000)
  expect(loaded?.sessions[9_999]).toEqual(state.sessions[9_999])
}, 60_000)

test('a background write produces the same state a synchronous one does, encrypted or not', async () => {
  // Text that stresses the piecewise encoding: multi-byte characters, escapes,
  // and enough sessions to span several pieces.
  const state = bigState(123)
  state.sessions[5]!.title = 'naïve — 日本語 😀 "quoted" \\ \n\t'
  state.sessions[77]!.viewers = [{ hash: 'h'.repeat(64), salt: 'v'.repeat(32), created_at: 2, last_used: 3, index: 'i'.repeat(64) }]
  state.claims = [{ id: 'ses_claimed', hash: 'o'.repeat(64), salt: 'p'.repeat(32), at: Date.now() }]

  for (const key of [stateKey({ RELAY_STATE_KEY: KEY } as NodeJS.ProcessEnv), null]) {
    const syncFile = path.join(dir, `sync-${key ? 'enc' : 'plain'}.json`)
    const sync = new FileStateStore(syncFile, 0, key)
    sync.schedule(() => state)
    sync.flush()

    const bgFile = path.join(dir, `bg-${key ? 'enc' : 'plain'}.json`)
    const bg = new FileStateStore(bgFile, 0, key)
    bg.schedule(() => state)
    await worstLag(() => existsSync(bgFile), 10_000)
    await bg.settled()

    expect(new FileStateStore(bgFile, 0, key).load()).toEqual(new FileStateStore(syncFile, 0, key).load())
    if (!key) expect(readFileSync(bgFile, 'utf8')).toBe(readFileSync(syncFile, 'utf8'))
  }
}, 30_000)

test('a shutdown flush during a background write wins, and the older write never lands over it', async () => {
  let current = bigState(3_000)
  let started = false
  const write = new FileStateStore(file, 0, stateKey({ RELAY_STATE_KEY: KEY } as NodeJS.ProcessEnv))
  write.schedule(() => {
    started = true
    return current
  })
  await worstLag(() => started, 10_000)

  // The background write is under way with the 3,000-session state; the set
  // changes and the relay shuts down before it finishes.
  current = bigState(1)
  write.schedule(() => current)
  write.flush()
  const load = () => new FileStateStore(file, 0, stateKey({ RELAY_STATE_KEY: KEY } as NodeJS.ProcessEnv)).load()
  expect(load()?.sessions.length).toBe(1)

  await write.settled()
  expect(load()?.sessions.length).toBe(1)
  expect(existsSync(`${file}.tmp`)).toBe(false)
}, 30_000)

test('a flush with nothing queued still lands a background write that is under way', async () => {
  // The write in progress has not reached the file yet; a process that exits
  // right after this flush must not leave the file behind it.
  let started = false
  const state = bigState(3_000)
  const write = new FileStateStore(file, 0, null)
  write.schedule(() => {
    started = true
    return state
  })
  await worstLag(() => started, 10_000)
  write.flush()
  expect(new FileStateStore(file, 0, null).load()?.sessions.length).toBe(3_000)
  await write.settled()
  expect(new FileStateStore(file, 0, null).load()?.sessions.length).toBe(3_000)
}, 30_000)
