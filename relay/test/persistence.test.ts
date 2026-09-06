import { afterEach, beforeEach, expect, test } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import { Store } from '../src/store'
import { FileStateStore, stateKey } from '../src/persist'
import { startServer } from '../src/server'

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
  delete process.env.RELAY_STATE_FILE
  delete process.env.RELAY_STATE_KEY
  rmSync(dir, { recursive: true, force: true })
})

test('a snapshot round-trips every credential check', () => {
  const a = new Store()
  const created = a.createSession('ses_p1', '/work', 'title', '1.2.3.4')
  const { viewer_token } = a.activate(created.access_code, 'ses_p1', '5.6.7.8')

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
  const activated = b.activate(created.access_code, 'ses_p1', '0.0.0.0')
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
  const activated = b.activate(created.access_code, 'ses_enc', '9.9.9.9')
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
  const { viewer_token } = store.activate(created.access_code, 'ses_pt', '5.6.7.8')
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
  expect(() => b.activate(created.access_code, 'ses_pt', '9.9.9.9')).toThrow()
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
