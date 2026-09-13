import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import { WebSocket } from 'ws'
import { Store } from '../src/store'
import type { PersistedState } from '../src/persist'
import { FileStateStore, stateKey } from '../src/persist'
import { shutdown, startServer } from '../src/server'

/**
 * A relay restart used to end every share: the store is a set of in-memory
 * Maps, so a redeploy dropped all sessions and viewer tokens. Viewers saw a
 * mid-stream EOF, then 401 on their cookie and 404 on the join page, while
 * their bridge was still running with nothing to reconnect to.
 *
 * The state file is encrypted at rest with RELAY_STATE_KEY (a key held outside
 * the volume): with a key the full session — code included — survives a
 * restart AND a volume copy is useless without the key; without a key the file
 * is plaintext and the crackable code hash / owner IP are stripped before
 * writing (the safe fallback).
 */

const API_KEY = 'test-relay-key'
process.env.RELAY_API_KEY = API_KEY
const KEY = randomBytes(32).toString('hex')

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'relay-persist-'))
  file = path.join(dir, 'state', 'sessions.json')
})

afterEach(() => {
  vi.useRealTimers()
  delete process.env.RELAY_STATE_FILE
  delete process.env.RELAY_STATE_KEY
  rmSync(dir, { recursive: true, force: true })
})

test('a snapshot round-trips every credential check', () => {
  const a = new Store()
  const created = a.createSession('ses_p1', '/work', 'title', '1.2.3.4')
  const { viewer_token } = a.activate(created.access_code, 'ses_p1')

  const b = new Store()
  expect(b.restore(a.snapshot())).toBe(1)

  expect(b.getSession('ses_p1')?.directory).toBe('/work')
  expect(b.verifyBridgeToken('ses_p1', created.bridge_token)).toBe(true)
  expect(b.verifyBridgeToken('ses_p1', 'wrong-token')).toBe(false)
  expect(b.verifyViewer('ses_p1', viewer_token)).toBe(true)
  expect(b.verifyViewer('ses_p1', 'wrong-token')).toBe(false)
  expect(b.getSessionByViewerToken(viewer_token)?.id).toBe('ses_p1')
  // A full in-memory snapshot carries the code, so the code still works after
  // restore (this is the encrypted-on-disk path; plaintext strips it below).
  const activated = b.activate(created.access_code, 'ses_p1')
  expect(activated.session_id).toBe('ses_p1')
})

test('ENCRYPTED file: a live share AND its unused code survive a restart', () => {
  process.env.RELAY_STATE_KEY = KEY
  const a = new Store()
  const created = a.createSession('ses_enc', '/work', 'title', '1.2.3.4')
  const write = new FileStateStore(file, 0)
  expect(write.encrypted).toBe(true)
  write.schedule(() => a.snapshot())
  write.flush()

  // On disk it is an AES-GCM envelope, not readable state.
  const raw = readFileSync(file, 'utf8')
  const parsed = JSON.parse(raw) as Record<string, unknown>
  expect(parsed.enc).toBe('aes-256-gcm')
  expect(typeof parsed.ct).toBe('string')
  expect(raw).not.toContain('ses_enc') // the id itself is inside the ciphertext
  expect(raw).not.toContain(created.access_code)

  // Restore with the key → the code still activates a fresh viewer.
  const b = new Store()
  expect(b.restore(new FileStateStore(file, 0).load())).toBe(1)
  const activated = b.activate(created.access_code, 'ses_enc')
  expect(activated.session_id).toBe('ses_enc')
  expect(b.verifyViewer('ses_enc', activated.viewer_token)).toBe(true)
})

test('ENCRYPTED file is unreadable without the key (a stolen volume copy is useless)', () => {
  const write = new FileStateStore(file, 0, stateKey({ RELAY_STATE_KEY: KEY } as NodeJS.ProcessEnv))
  const a = new Store()
  a.createSession('ses_secret', '/work', 'private title', '1.2.3.4')
  write.schedule(() => a.snapshot())
  write.flush()

  // No key, or the wrong key, both yield "start empty" — never a crash, never
  // trusted garbage (GCM auth fails on the wrong key).
  expect(new FileStateStore(file, 0, null).load()).toBeUndefined()
  const wrong = stateKey({ RELAY_STATE_KEY: randomBytes(32).toString('hex') } as NodeJS.ProcessEnv)
  expect(new FileStateStore(file, 0, wrong).load()).toBeUndefined()
  // The private title is nowhere in the raw bytes.
  expect(readFileSync(file, 'utf8')).not.toContain('private title')
})

test('PLAINTEXT file (no key): stores no code hash, code salt or owner IP', () => {
  const store = new Store()
  const created = store.createSession('ses_pt', '/work', 'title', '1.2.3.4')
  const { viewer_token } = store.activate(created.access_code, 'ses_pt')
  const write = new FileStateStore(file, 0, null)
  expect(write.encrypted).toBe(false)
  write.schedule(() => store.snapshot())
  write.flush()

  const raw = readFileSync(file, 'utf8')
  const entry = (JSON.parse(raw) as { sessions: Array<Record<string, unknown>> }).sessions[0]!
  expect(raw).not.toContain(created.access_code)
  expect(raw).not.toContain(created.bridge_token)
  expect(raw).not.toContain(viewer_token)
  expect(entry.code_hash).toBeUndefined()
  expect(entry.code_salt).toBeUndefined()
  expect(entry.created_by_ip).toBeUndefined()
  expect(typeof entry.bridge_token_hash).toBe('string')
  expect(Array.isArray(entry.viewers)).toBe(true)

  // A restored plaintext session: already-joined viewer works, unused code does not.
  const b = new Store()
  b.restore(new FileStateStore(file, 0, null).load())
  expect(b.verifyViewer('ses_pt', viewer_token)).toBe(true)
  expect(() => b.activate(created.access_code, 'ses_pt')).toThrow()
})

test('stateKey accepts hex, 32-byte base64, or folds any secret to 32 bytes', () => {
  expect(stateKey({} as NodeJS.ProcessEnv)).toBeNull()
  expect(stateKey({ RELAY_STATE_KEY: '' } as NodeJS.ProcessEnv)).toBeNull()
  const hex = stateKey({ RELAY_STATE_KEY: 'a'.repeat(64) } as NodeJS.ProcessEnv)!
  expect(hex.length).toBe(32)
  const b64 = stateKey({ RELAY_STATE_KEY: randomBytes(32).toString('base64') } as NodeJS.ProcessEnv)!
  expect(b64.length).toBe(32)
  const folded = stateKey({ RELAY_STATE_KEY: 'a short passphrase' } as NodeJS.ProcessEnv)!
  expect(folded.length).toBe(32)
})

test('restore drops sessions that are already past the idle deadline', () => {
  const store = new Store()
  store.createSession('ses_fresh', '/work', 't', '1.1.1.1')
  const snapshot = store.snapshot()
  snapshot.sessions.push({
    ...snapshot.sessions[0]!,
    id: 'ses_stale',
    last_seen: Date.now() - 10_000,
  })
  const restored = new Store()
  expect(restored.restore(snapshot, 5_000)).toBe(1)
  expect(restored.getSession('ses_fresh')).toBeTruthy()
  expect(restored.getSession('ses_stale')).toBeUndefined()
})

test('restore drops a session with no usable bridge-token hash', () => {
  const store = new Store()
  store.createSession('ses_good', '/w', 't', '1.1.1.1')
  const snap = store.snapshot()
  snap.sessions.push({ ...snap.sessions[0]!, id: 'ses_notoken', bridge_token_hash: undefined as never })
  snap.sessions.push({ ...snap.sessions[0]!, id: 'ses_badtype', bridge_token_salt: 123 as never })
  const restored = new Store()
  expect(restored.restore(snap)).toBe(1)
  expect(restored.getSession('ses_good')).toBeTruthy()
  expect(restored.getSession('ses_notoken')).toBeUndefined()
  expect(restored.getSession('ses_badtype')).toBeUndefined()
})

test('a missing, corrupt or foreign-version file starts the relay empty instead of failing', () => {
  expect(new FileStateStore(file, 0, null).load()).toBeUndefined()

  const store = new Store()
  const write = new FileStateStore(file, 0, null)
  write.schedule(() => store.snapshot())
  write.flush()

  writeFileSync(file, '{ this is not json')
  expect(new FileStateStore(file, 0, null).load()).toBeUndefined()
  expect(new Store().restore(new FileStateStore(file, 0, null).load())).toBe(0)

  writeFileSync(file, JSON.stringify({ version: 99, saved_at: 1, sessions: [] }))
  expect(new FileStateStore(file, 0, null).load()).toBeUndefined()
})

test('writes are atomic and leave no temp file behind', () => {
  const store = new Store()
  store.createSession('ses_atomic', '/work', 't', '1.1.1.1')
  const write = new FileStateStore(file, 0)
  write.schedule(() => store.snapshot())
  write.flush()
  expect(existsSync(file)).toBe(true)
  expect(existsSync(`${file}.tmp`)).toBe(false)
  expect(() => JSON.parse(readFileSync(file, 'utf8'))).not.toThrow()
})

test('writes collapse inside the debounce window', async () => {
  const store = new Store()
  const write = new FileStateStore(file, 30, null)
  let snapshots = 0
  for (let i = 0; i < 25; i++) {
    store.createSession(`ses_burst${i}`, '/work', 't', '1.1.1.1')
    write.schedule(() => {
      snapshots += 1
      return store.snapshot()
    })
  }
  expect(snapshots).toBe(0) // nothing written synchronously
  await new Promise((resolve) => setTimeout(resolve, 80))
  expect(snapshots).toBe(1) // one write for the whole burst
  expect(new FileStateStore(file, 0, null).load()!.sessions.length).toBe(25)
})

test('a live share survives a full relay restart', async () => {
  process.env.RELAY_STATE_FILE = file
  process.env.RELAY_STATE_KEY = KEY
  let relay: Server = await startServer(0)
  const url = () => `http://127.0.0.1:${(relay.address() as AddressInfo).port}`

  const created = await request(relay)
    .post('/api/sessions')
    .set('x-api-key', API_KEY)
    .send({ session_id: 'ses_restart', directory: '/work', title: 'live share' })
  expect(created.status).toBe(201)
  const activated = await request(relay)
    .post('/api/activate')
    .send({ code: created.body.access_code, session_id: 'ses_restart' })
  expect(activated.status).toBe(200)
  const viewerToken: string = activated.body.viewer_token

  // Restart exactly like a redeploy does: close the process, start a new one.
  relay.closeAllConnections()
  await new Promise((resolve) => relay.close(resolve))
  relay = await startServer(0)
  try {
    // The viewer's token still opens its stream instead of 401.
    const stream = await fetch(`${url()}/event`, { headers: { 'x-viewer-token': viewerToken } })
    expect(stream.status).toBe(200)
    await stream.body?.cancel()

    // The join page is served again instead of "Session not found".
    const page = await request(relay).get('/ses_restart')
    expect(page.status).toBe(200)

    // The session is public-visible again (presence only; directory is
    // owner-gated and comes back with the bridge token).
    const presence = await request(relay).get('/api/sessions/ses_restart')
    expect(presence.status).toBe(200)
    expect(presence.body.directory).toBeUndefined()
    const owner = await request(relay)
      .get('/api/sessions/ses_restart')
      .set('x-bridge-token', created.body.bridge_token)
    expect(owner.body.directory).toBe('/work')

    // The unused access code STILL works after the restart (encrypted state).
    const rejoin = await request(relay)
      .post('/api/activate')
      .send({ code: created.body.access_code, session_id: 'ses_restart' })
    expect(rejoin.status).toBe(200)

    // ...and the bridge's own token is still the one that may delete it.
    const wrongDelete = await request(relay)
      .delete('/api/sessions/ses_restart')
      .set('x-bridge-token', 'not-the-token')
    expect(wrongDelete.status).toBe(404)
    expect((await request(relay).get('/api/sessions/ses_restart')).status).toBe(200)
    const rightDelete = await request(relay)
      .delete('/api/sessions/ses_restart')
      .set('x-bridge-token', created.body.bridge_token)
    expect(rightDelete.status).toBe(204)
  } finally {
    relay.closeAllConnections()
    await new Promise((resolve) => relay.close(resolve))
  }
}, 20_000)

test('a deleted session does not come back after a restart', async () => {
  process.env.RELAY_STATE_FILE = file
  process.env.RELAY_STATE_KEY = KEY
  let relay: Server = await startServer(0)
  const created = await request(relay)
    .post('/api/sessions')
    .set('x-api-key', API_KEY)
    .send({ session_id: 'ses_gone', directory: '/work', title: 't' })
  await request(relay)
    .delete('/api/sessions/ses_gone')
    .set('x-bridge-token', created.body.bridge_token)
    .expect(204)
  relay.closeAllConnections()
  await new Promise((resolve) => relay.close(resolve))

  relay = await startServer(0)
  try {
    const presence = await request(relay).get('/api/sessions/ses_gone')
    expect(presence.status).toBe(404)
  } finally {
    relay.closeAllConnections()
    await new Promise((resolve) => relay.close(resolve))
  }
}, 20_000)

test('with no RELAY_STATE_FILE nothing is written and a restart is still clean', async () => {
  let relay: Server = await startServer(0)
  const created = await request(relay)
    .post('/api/sessions')
    .set('x-api-key', API_KEY)
    .send({ session_id: 'ses_nopersist', directory: '/work', title: 't' })
  expect(created.status).toBe(201)
  relay.closeAllConnections()
  await new Promise((resolve) => relay.close(resolve))
  expect(existsSync(file)).toBe(false)

  relay = await startServer(0)
  try {
    expect((await request(relay).get('/api/sessions/ses_nopersist')).status).toBe(404)
  } finally {
    relay.closeAllConnections()
    await new Promise((resolve) => relay.close(resolve))
  }
}, 20_000)

test('the shutdown flush handle writes the latest state without waiting for close', async () => {
  // The 'close' event never fires while a viewer SSE stream is open, so the
  // signal handler flushes via this handle instead — otherwise a redeploy
  // would lose the last snapshot exactly when it is needed.
  process.env.RELAY_STATE_FILE = file
  process.env.RELAY_STATE_KEY = KEY
  const relay = await startServer(0)
  const port = (relay.address() as AddressInfo).port
  try {
    const created = await request(relay)
      .post('/api/sessions')
      .set('x-api-key', API_KEY)
      .send({ session_id: 'ses_flush', directory: '/w', title: 't' })
    const act = await request(relay)
      .post('/api/activate')
      .send({ code: created.body.access_code, session_id: 'ses_flush' })
    // Hold a live SSE stream open — this is what blocks the 'close' event.
    const stream = await fetch(`http://127.0.0.1:${port}/event`, {
      headers: { 'x-viewer-token': act.body.viewer_token },
    })
    expect(stream.status).toBe(200)

    // Flush immediately, before the 400ms debounce would fire on its own.
    const flushState = (relay as unknown as { flushState?: () => void }).flushState
    expect(typeof flushState).toBe('function')
    flushState!()

    const onDisk = new FileStateStore(file, 0).load()
    expect(onDisk?.sessions.map((s) => s.id)).toContain('ses_flush')

    await stream.body?.cancel()
  } finally {
    relay.closeAllConnections()
    await new Promise((resolve) => relay.close(resolve))
  }
}, 20_000)

/**
 * A share that stayed quiet for a day did not survive the next restart.
 *
 * Nothing wrote the state file while a share was merely in use. last_seen was
 * re-persisted only when it had moved a minute past the PREVIOUS touch, and a
 * connected bridge touches its session on every pong (25 s) and every byte it
 * sends, so that gap never came. Viewer use slid last_used in memory only, and
 * the shutdown flush wrote nothing unless a write was already queued. So the
 * file kept the timestamps of the last create, activate, delete or reap
 * anywhere on the relay. restore() drops a session whose last_seen is older
 * than a day, and a viewer idle for longer: a redeploy or a crash after an
 * overnight or weekend share answered the viewers 404 and 401 and refused the
 * still-running bridge with 401, which it takes as fatal and ends the share.
 */

const HOUR = 3_600_000
/** The relay's production keep-alive ping interval. */
const PONG_EVERY_MS = 25_000

test('a snapshot keeps up with a share whose bridge only answers pings for over a day', () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const store = new Store()
  let lastSnapshot: PersistedState | undefined
  // What the relay would find on disk after a crash: the last snapshot the
  // store asked to have written.
  store.setChangeListener(() => {
    lastSnapshot = store.snapshot()
  })
  const created = store.createSession('ses_quiet_store', '/work', 't', '1.2.3.4')
  const { viewer_token } = store.activate(created.access_code, 'ses_quiet_store')

  const started = Date.now()
  for (let t = PONG_EVERY_MS; t <= 25 * HOUR; t += PONG_EVERY_MS) {
    vi.setSystemTime(started + t)
    store.touchSession('ses_quiet_store')
    // The open tab's event stream re-checks its token as it goes.
    if (t % (15 * 60_000) === 0) expect(store.verifyViewer('ses_quiet_store', viewer_token)).toBe(true)
  }

  const restarted = new Store()
  expect(restarted.restore(lastSnapshot)).toBe(1)
  expect(restarted.verifyBridgeToken('ses_quiet_store', created.bridge_token)).toBe(true)
  expect(restarted.verifyViewer('ses_quiet_store', viewer_token)).toBe(true)
})

test("a snapshot carries a viewer's sliding window, not the time its token was issued", () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const store = new Store()
  let lastSnapshot: PersistedState | undefined
  store.setChangeListener(() => {
    lastSnapshot = store.snapshot()
  })
  const created = store.createSession('ses_viewer_slide', '/work', 't', '1.2.3.4')
  const { viewer_token } = store.activate(created.access_code, 'ses_viewer_slide')

  // Only the viewer is active: nothing touches the session itself.
  const started = Date.now()
  for (let t = 15_000; t <= 2 * HOUR; t += 15_000) {
    vi.setSystemTime(started + t)
    expect(store.verifyViewer('ses_viewer_slide', viewer_token)).toBe(true)
  }

  const persisted = lastSnapshot!.sessions[0]!.viewers[0]!
  // Persisting is throttled, so the snapshot may trail by up to a minute.
  expect(Date.now() - persisted.last_used!).toBeLessThanOrEqual(60_000)
})

test('the shutdown flush writes timestamps that moved since the last write', async () => {
  process.env.RELAY_STATE_FILE = file
  process.env.RELAY_STATE_KEY = KEY
  vi.useFakeTimers({ toFake: ['Date'] })
  const relay = await startServer(0)
  const port = (relay.address() as AddressInfo).port
  let bridge: WebSocket | undefined
  try {
    const created = await request(relay)
      .post('/api/sessions')
      .set('x-api-key', API_KEY)
      .send({ session_id: 'ses_flush_fresh', directory: '/w', title: 't' })
    const act = await request(relay)
      .post('/api/activate')
      .send({ code: created.body.access_code, session_id: 'ses_flush_fresh' })
    expect(act.status).toBe(200)
    const flushState = (relay as unknown as { flushState: () => void }).flushState
    // The debounced write for the activation lands.
    flushState()

    // Half a minute of use: less than any persist throttle, so nothing queues.
    vi.setSystemTime(Date.now() + 30_000)
    const usedAt = Date.now()
    await request(relay)
      .get('/ses_flush_fresh')
      .set('cookie', `viewer_token=${act.body.viewer_token}`)
      .expect(302)
    const link = new WebSocket(`ws://127.0.0.1:${port}/bridge?session_id=ses_flush_fresh`, {
      headers: { 'x-bridge-token': created.body.bridge_token },
    })
    bridge = link
    await new Promise((resolve, reject) => {
      link.once('open', resolve)
      link.once('error', reject)
    })
    // Any byte from the bridge touches its session; the pong proves it was read.
    await new Promise((resolve) => {
      link.once('pong', resolve)
      link.ping()
    })

    flushState()
    const onDisk = new FileStateStore(file, 0).load()!.sessions[0]!
    expect(onDisk.last_seen).toBe(usedAt)
    expect(onDisk.viewers[0]!.last_used).toBe(usedAt)
  } finally {
    bridge?.terminate()
    relay.closeAllConnections()
    await new Promise((resolve) => relay.close(resolve))
  }
}, 20_000)

test('shutdown leaves alone a state file the relay could not read', async () => {
  // The shutdown flush now writes the store as it is. A relay started with the
  // wrong RELAY_STATE_KEY holds nothing, and must not make that permanent.
  const a = new Store()
  a.createSession('ses_unread', '/work', 't', '1.2.3.4')
  const write = new FileStateStore(file, 0, stateKey({ RELAY_STATE_KEY: KEY } as NodeJS.ProcessEnv))
  write.schedule(() => a.snapshot())
  write.flush()
  const before = readFileSync(file, 'utf8')

  process.env.RELAY_STATE_FILE = file
  process.env.RELAY_STATE_KEY = randomBytes(32).toString('hex')
  const relay = await startServer(0)
  expect((await request(relay).get('/api/sessions/ses_unread')).status).toBe(404)
  await shutdown(relay)

  expect(readFileSync(file, 'utf8')).toBe(before)
}, 20_000)

test('a share kept alive by its bridge for over a day survives a redeploy', async () => {
  process.env.RELAY_STATE_FILE = file
  process.env.RELAY_STATE_KEY = KEY
  vi.useFakeTimers({ toFake: ['Date'] })
  let relay: Server = await startServer(0)
  const port = (relay.address() as AddressInfo).port
  const bridgeUrl = `ws://127.0.0.1:${port}/bridge?session_id=ses_overnight`
  const sockets: WebSocket[] = []
  /** Dial the bridge endpoint: 'open', or the HTTP status of the refusal. */
  const dial = async (token: string) => {
    const ws = new WebSocket(bridgeUrl, { headers: { 'x-bridge-token': token } })
    sockets.push(ws)
    ws.on('error', () => {})
    const outcome = await new Promise<'open' | number>((resolve) => {
      ws.once('open', () => resolve('open'))
      ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
    })
    return { ws, outcome }
  }
  try {
    const created = await request(relay)
      .post('/api/sessions')
      .set('x-api-key', API_KEY)
      .send({ session_id: 'ses_overnight', directory: '/work', title: 'overnight' })
    expect(created.status).toBe(201)
    const act = await request(relay)
      .post('/api/activate')
      .send({ code: created.body.access_code, session_id: 'ses_overnight' })
    expect(act.status).toBe(200)
    const viewerCookie = `viewer_token=${act.body.viewer_token}`
    const link = await dial(created.body.bridge_token)
    expect(link.outcome).toBe('open')
    // Let the activation's debounced write land now. Left queued, it would
    // take its snapshot whenever the timer fired, somewhere inside the loop.
    ;(relay as unknown as { flushState: () => void }).flushState()

    // 25 hours in which nobody creates, joins or stops anything. The bridge
    // answers every keep-alive; the open tab keeps using its token.
    const started = Date.now()
    for (let t = PONG_EVERY_MS; t <= 25 * HOUR; t += PONG_EVERY_MS) {
      vi.setSystemTime(started + t)
      // Any byte from the bridge touches its session; the pong comes back only
      // after the relay has read the ping, so each step is really seen.
      await new Promise((resolve) => {
        link.ws.once('pong', resolve)
        link.ws.ping()
      })
      if (t % (10 * 60_000) === 0) {
        await request(relay).get('/ses_overnight').set('cookie', viewerCookie).expect(302)
      }
    }

    // Redeploy: the signal handler's shutdown, the old process's exit taking
    // the bridge link with it, then a new relay on the same state file.
    const closed = shutdown(relay)
    link.ws.terminate()
    await closed
    relay = await startServer(port)

    expect((await request(relay).get('/api/sessions/ses_overnight')).status).toBe(200)
    // The still-running bridge is let back in instead of refused with 401...
    expect((await dial(created.body.bridge_token)).outcome).toBe('open')
    // ...and the viewer's tab is still in its share.
    await request(relay).get('/ses_overnight').set('cookie', viewerCookie).expect(302)
  } finally {
    for (const ws of sockets) ws.terminate()
    if (relay.listening) {
      relay.closeAllConnections()
      await new Promise((resolve) => relay.close(resolve))
    }
  }
}, 30_000)
