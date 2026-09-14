import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { createApp } from '../src/server'
import { Store } from '../src/store'
import { BridgeClient } from '../src/ws/bridge'
import { FileStateStore } from '../src/persist'
import { config } from '../src/config'

/**
 * A share URL is public, and it names the opencode session id — the same id
 * the owner registers again every time they share that conversation. The relay
 * used to key a session on nothing else: once the owner stopped (or the reaper
 * removed a share whose bridge died), anyone holding the old link could POST
 * that id first, get a bridge_token for it, and keep the registration alive
 * forever with a connected socket (every pong refreshes last_seen, so the
 * reaper never fires; without a socket it still lasted a day). The owner's own
 * start then failed with a bare 409 it had no token to clear, and the old link
 * served the squatter's join page. Reproduced against the real hub and the
 * real bridge library: attacker 201, owner 409, no DELETE recourse.
 *
 * A bridge now proves which install shared an id with an owner_key (an HMAC of
 * the relay's origin and the id under a secret that never leaves the owner's
 * machine; bridge/test/owner-key.test.ts checks the relay binding). The relay
 * keeps a salted hash of it on the session, and after the session ends as a
 * claim that outlives it: only the same key may register that id again, and
 * the same key may replace its own registration outright — a start after a
 * crash no longer waits a day. An id never registered with a key behaves as
 * before, so older bridges keep working.
 *
 * Harness: createApp + BridgeClient over one ephemeral http server, exactly
 * what startServer wires, with a real ws client as the bridge. Owner and
 * attacker come from different X-Forwarded-For addresses (documentation IPs).
 */

process.env.ACTIVATE_FAIL_DELAY_MS = '0'

const OWNER_IP = '198.51.100.7'
const ATTACKER_IP = '203.0.113.66'

let server: http.Server
let store: Store
let bridge: BridgeClient
let base: string
const sockets: WebSocket[] = []

async function listen(s: Store) {
  store = s
  server = http.createServer()
  bridge = new BridgeClient(server, store)
  server.on('request', createApp(store, bridge))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function close() {
  for (const ws of sockets.splice(0)) ws.terminate()
  bridge.close()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}

beforeEach(() => listen(new Store()))
afterEach(async () => {
  vi.restoreAllMocks()
  await close()
})

function ownerKey(): string {
  return randomBytes(32).toString('base64url')
}

async function register(session_id: string, ip: string, owner_key?: unknown) {
  const res = await fetch(`http://${base}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({
      session_id,
      directory: ip === OWNER_IP ? '/owner/project' : '/attacker/dir',
      title: 't',
      ...(owner_key === undefined ? {} : { owner_key }),
    }),
  })
  const body = (await res.json().catch(() => ({}))) as {
    access_code?: string
    bridge_token?: string
    replaced?: unknown
    error?: string
  }
  return { status: res.status, body }
}

async function remove(session_id: string, token: string): Promise<number> {
  const res = await fetch(`http://${base}/api/sessions/${encodeURIComponent(session_id)}`, {
    method: 'DELETE',
    headers: { 'x-bridge-token': token },
  })
  return res.status
}

function connect(session_id: string, token: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://${base}/bridge?session_id=${encodeURIComponent(session_id)}`, {
    headers: { 'x-bridge-token': token },
  })
  sockets.push(ws)
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

function closeCode(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.once('close', (code) => resolve(code)))
}

test('an id the owner stopped sharing cannot be taken by anyone else, and the owner shares it again', async () => {
  const K = ownerKey()
  const first = await register('ses_squat1', OWNER_IP, K)
  expect(first.status).toBe(201)
  expect(await remove('ses_squat1', first.body.bridge_token!)).toBe(204)

  // The share link is public: whoever holds it knows the id.
  const squat = await register('ses_squat1', ATTACKER_IP)
  expect(squat.status).toBe(409)
  expect((await register('ses_squat1', ATTACKER_IP, ownerKey())).status).toBe(409)
  expect(store.getSession('ses_squat1')).toBeUndefined()

  const again = await register('ses_squat1', OWNER_IP, K)
  expect(again.status).toBe(201)
  expect(again.body.access_code).toMatch(/^[A-Z0-9]{6}$/)
  // The response shape is unchanged: no bookkeeping leaks into it.
  expect(again.body.replaced).toBeUndefined()
})

test('a share the reaper removed (its bridge died, nobody stopped it) stays reserved for its owner', async () => {
  const K = ownerKey()
  const first = await register('ses_squat2', OWNER_IP, K)
  expect(first.status).toBe(201)
  const now = Date.now()
  vi.spyOn(Date, 'now').mockReturnValue(now + config.orphanReapMs + 60_000)
  expect(store.reapOrphans(config.orphanReapMs)).toEqual(['ses_squat2'])

  expect((await register('ses_squat2', ATTACKER_IP)).status).toBe(409)
  expect((await register('ses_squat2', OWNER_IP, K)).status).toBe(201)
})

test('the owner replaces its own stale registration: the old bridge is dropped and its token and viewers revoked', async () => {
  const K = ownerKey()
  const first = await register('ses_crash1', OWNER_IP, K)
  expect(first.status).toBe(201)
  const oldSocket = await connect('ses_crash1', first.body.bridge_token!)
  const { viewer_token } = store.activate(first.body.access_code!, 'ses_crash1')
  const closed = closeCode(oldSocket)

  // Nobody else can: not without a key, not with the wrong one. The live
  // share is untouched.
  expect((await register('ses_crash1', ATTACKER_IP)).status).toBe(409)
  expect((await register('ses_crash1', ATTACKER_IP, ownerKey())).status).toBe(409)
  expect(bridge.isConnected('ses_crash1')).toBe(true)
  expect(store.verifyViewer('ses_crash1', viewer_token)).toBe(true)

  // A bridge that died without a word (SIGKILL, a reboot) and starts again.
  const second = await register('ses_crash1', OWNER_IP, K)
  expect(second.status).toBe(201)
  expect(second.body.replaced).toBeUndefined()
  expect(second.body.bridge_token).not.toBe(first.body.bridge_token)
  expect(second.body.access_code).toBeTruthy()

  expect(await closed).toBe(4001)
  expect(store.verifyViewer('ses_crash1', viewer_token)).toBe(false)
  expect(store.getSessionByViewerToken(viewer_token)).toBeUndefined()
  expect(await remove('ses_crash1', first.body.bridge_token!)).toBe(404)

  await connect('ses_crash1', second.body.bridge_token!)
  expect(bridge.isConnected('ses_crash1')).toBe(true)
  expect(store.sessionCount()).toBe(1)
})

test('the claim survives a relay restart, both from a snapshot and from a plaintext state file', async () => {
  const K = ownerKey()
  const first = await register('ses_persist1', OWNER_IP, K)
  expect(first.status).toBe(201)
  expect(await remove('ses_persist1', first.body.bridge_token!)).toBe(204)
  // A live keyed share whose relay was down for longer than the idle limit is
  // dropped on restore — but it stays its owner's.
  expect((await register('ses_persist2', OWNER_IP, K)).status).toBe(201)
  store.getSession('ses_persist2')!.last_seen = Date.now() - config.orphanReapMs - 60_000
  const snapshot = store.snapshot()

  const dir = mkdtempSync(path.join(tmpdir(), 'relay-claims-'))
  try {
    const file = path.join(dir, 'sessions.json')
    const plaintext = new FileStateStore(file, 0, null)
    plaintext.schedule(() => snapshot)
    plaintext.flush()

    for (const state of [snapshot, new FileStateStore(file, 0, null).load()]) {
      await close()
      const restored = new Store()
      restored.restore(state)
      await listen(restored)
      expect(store.getSession('ses_persist2')).toBeUndefined()
      expect((await register('ses_persist1', ATTACKER_IP)).status).toBe(409)
      expect((await register('ses_persist2', ATTACKER_IP)).status).toBe(409)
      expect((await register('ses_persist1', OWNER_IP, K)).status).toBe(201)
      expect((await register('ses_persist2', OWNER_IP, K)).status).toBe(201)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an id registered without a key behaves as before, and a claim expires', async () => {
  // Older bridges send no owner_key: a never-seen id is theirs, a live one is
  // still refused, and ending it reserves nothing.
  const legacy = await register('ses_legacy1', OWNER_IP)
  expect(legacy.status).toBe(201)
  expect((await register('ses_legacy1', ATTACKER_IP, ownerKey())).status).toBe(409)
  expect(await remove('ses_legacy1', legacy.body.bridge_token!)).toBe(204)
  expect((await register('ses_legacy1', ATTACKER_IP)).status).toBe(201)

  // A key too short to be a secret would only turn the claim into a guessing
  // game (a 409 costs the caller nothing), so it is refused outright.
  expect((await register('ses_badkey', OWNER_IP, 'short')).status).toBe(400)
  expect((await register('ses_badkey', OWNER_IP, 42)).status).toBe(400)
  expect((await register('ses_badkey', OWNER_IP, 'k'.repeat(1024))).status).toBe(400)

  const K = ownerKey()
  const keyed = await register('ses_expire1', OWNER_IP, K)
  expect(await remove('ses_expire1', keyed.body.bridge_token!)).toBe(204)
  const now = Date.now()
  vi.spyOn(Date, 'now').mockReturnValue(now + config.ownerClaimTtlMs + 60_000)
  expect((await register('ses_expire1', ATTACKER_IP)).status).toBe(201)
})
