import { afterEach, beforeEach, expect, test } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import { Store } from '../src/store'
import { FileStateStore } from '../src/persist'
import { startServer } from '../src/server'

/**
 * A relay restart used to end every share: the store is a set of in-memory
 * Maps, so a redeploy dropped all sessions and viewer tokens. Viewers saw a
 * mid-stream EOF, then 401 on their cookie and 404 on the join page, while
 * their bridge was still running with nothing to reconnect to.
 */

const API_KEY = 'test-relay-key'
process.env.RELAY_API_KEY = API_KEY

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'relay-persist-'))
  file = path.join(dir, 'state', 'sessions.json')
})

afterEach(() => {
  delete process.env.RELAY_STATE_FILE
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
  // The access code is NOT round-tripped — it is never written to disk.
  expect(() => b.activate(created.access_code, 'ses_p1', '0.0.0.0')).toThrow()
})

test('an already-joined viewer survives a restore, but the unused code does not', () => {
  const a = new Store()
  const created = a.createSession('ses_p2', '/work', 'title', '1.2.3.4')
  const { viewer_token } = a.activate(created.access_code, 'ses_p2', '5.5.5.5')
  const b = new Store()
  b.restore(a.snapshot())
  // The viewer who already joined keeps working on their 256-bit token...
  expect(b.verifyViewer('ses_p2', viewer_token)).toBe(true)
  // ...but the access code is NOT persisted, so a fresh join with it fails.
  // (This is the whole point: a crackable code is never written to disk.)
  expect(() => b.activate(created.access_code, 'ses_p2', '9.9.9.9')).toThrow()
})

test('the state file holds salted hashes, never a code or token', () => {
  const store = new Store()
  const created = store.createSession('ses_p3', '/work', 'title', '1.2.3.4')
  const { viewer_token } = store.activate(created.access_code, 'ses_p3', '5.6.7.8')
  const persistence = new FileStateStore(file, 0)
  persistence.schedule(() => store.snapshot())
  persistence.flush()

  const raw = readFileSync(file, 'utf8')
  const parsed = JSON.parse(raw) as { sessions: Array<Record<string, unknown>> }
  const entry = parsed.sessions.find((x) => x.id === 'ses_p3')!
  // Plaintext secrets never appear...
  expect(raw).not.toContain(created.access_code)
  expect(raw).not.toContain(created.bridge_token)
  expect(raw).not.toContain(viewer_token)
  // ...and the crackable code hash + owner IP are not persisted at all.
  expect(entry.code_hash).toBeUndefined()
  expect(entry.code_salt).toBeUndefined()
  expect(entry.created_by_ip).toBeUndefined()
  // The safe material IS there: the bridge-token hash and the viewer hash.
  expect(typeof entry.bridge_token_hash).toBe('string')
  expect(Array.isArray(entry.viewers)).toBe(true)
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

test('a missing, corrupt or foreign-version file starts the relay empty instead of failing', () => {
  expect(new FileStateStore(file).load()).toBeUndefined()

  const store = new Store()
  const persistence = new FileStateStore(file, 0)
  persistence.schedule(() => store.snapshot())
  persistence.flush()

  writeFileSync(file, '{ this is not json')
  expect(new FileStateStore(file).load()).toBeUndefined()
  expect(new Store().restore(new FileStateStore(file).load())).toBe(0)

  writeFileSync(file, JSON.stringify({ version: 99, saved_at: 1, sessions: [] }))
  expect(new FileStateStore(file).load()).toBeUndefined()
})

test('writes are atomic and leave no temp file behind', () => {
  const store = new Store()
  store.createSession('ses_atomic', '/work', 't', '1.1.1.1')
  const persistence = new FileStateStore(file, 0)
  persistence.schedule(() => store.snapshot())
  persistence.flush()
  expect(existsSync(file)).toBe(true)
  expect(existsSync(`${file}.tmp`)).toBe(false)
  expect(() => JSON.parse(readFileSync(file, 'utf8'))).not.toThrow()
})

test('writes collapse inside the debounce window', async () => {
  const store = new Store()
  const persistence = new FileStateStore(file, 30)
  let snapshots = 0
  for (let i = 0; i < 25; i++) {
    store.createSession(`ses_burst_${i}`, '/work', 't', '1.1.1.1')
    persistence.schedule(() => {
      snapshots += 1
      return store.snapshot()
    })
  }
  expect(snapshots).toBe(0) // nothing written synchronously
  await new Promise((resolve) => setTimeout(resolve, 80))
  expect(snapshots).toBe(1) // one write for the whole burst
  expect(new FileStateStore(file).load()!.sessions.length).toBe(25)
})

test('a live share survives a full relay restart', async () => {
  process.env.RELAY_STATE_FILE = file
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

    // ...and the bridge's own token is still the one that may delete it.
    // A wrong token answers 404 (it never reveals whether the session exists)
    // and, crucially, leaves the restored session alone.
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

test('the shutdown flush handle writes the latest state without waiting for close', async () => {
  // The 'close' event never fires while a viewer SSE stream is open, so the
  // signal handler flushes via this handle instead — otherwise a redeploy
  // would lose the last snapshot exactly when it is needed.
  process.env.RELAY_STATE_FILE = file
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

    const onDisk = new FileStateStore(file).load()
    expect(onDisk?.sessions.map((s) => s.id)).toContain('ses_flush')

    await stream.body?.cancel()
  } finally {
    relay.closeAllConnections()
    await new Promise((resolve) => relay.close(resolve))
  }
}, 20_000)
