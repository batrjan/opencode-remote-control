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
  await connect('ses_squat1', first.body.bridge_token!)
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
  await connect('ses_squat2', first.body.bridge_token!)
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
  await connect('ses_persist1', first.body.bridge_token!)
  expect(await remove('ses_persist1', first.body.bridge_token!)).toBe(204)
  // A live keyed share whose relay was down for longer than the idle limit is
  // dropped on restore — but it stays its owner's.
  const second = await register('ses_persist2', OWNER_IP, K)
  expect(second.status).toBe(201)
  await connect('ses_persist2', second.body.bridge_token!)
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
  await connect('ses_expire1', keyed.body.bridge_token!)
  expect(await remove('ses_expire1', keyed.body.bridge_token!)).toBe(204)
  expect((await register('ses_expire1', ATTACKER_IP)).status).toBe(409)
  const now = Date.now()
  vi.spyOn(Date, 'now').mockReturnValue(now + config.ownerClaimTtlMs + 60_000)
  expect((await register('ses_expire1', ATTACKER_IP)).status).toBe(201)
})

/** Date.now, moved forward by whatever the test adds to the returned offset. */
function clock(): { advance(ms: number): void } {
  const real = Date.now.bind(Date)
  let offset = 0
  vi.spyOn(Date, 'now').mockImplementation(() => real() + offset)
  return { advance: (ms) => void (offset += ms) }
}

/**
 * The reservation was recorded for every keyed registration that left the
 * store, including one no bridge ever connected to. So one POST, with a key of
 * the caller's own and nothing else, turned an id nobody reserved (every id an
 * older, keyless bridge shares) into a 30-day reservation for that caller once
 * the unbound reaper removed it, renewable by POSTing again: the owner's next
 * start got 409 for a month. A squatter used to have to hold a bridge socket.
 */
test('a registration no bridge ever took up reserves its id for nobody', async () => {
  const t = clock()
  // The owner shares with an older bridge (no key) and stops.
  const legacy = await register('ses_bare1', OWNER_IP)
  await connect('ses_bare1', legacy.body.bridge_token!)
  expect(await remove('ses_bare1', legacy.body.bridge_token!)).toBe(204)

  // Someone holding the old link registers the freed id with a key of their
  // own and never connects. The reaper removes it minutes later.
  expect((await register('ses_bare1', ATTACKER_IP, ownerKey())).status).toBe(201)
  t.advance(config.unboundReapMs + 60_000)
  expect(store.reapOrphans(config.orphanReapMs)).toEqual(['ses_bare1'])
  expect((await register('ses_bare1', OWNER_IP)).status).toBe(201)

  // Nor by deleting it with the token it got back.
  const squat = await register('ses_bare2', ATTACKER_IP, ownerKey())
  expect(squat.status).toBe(201)
  expect(await remove('ses_bare2', squat.body.bridge_token!)).toBe(204)
  expect((await register('ses_bare2', OWNER_IP, ownerKey())).status).toBe(201)

  // Nor by a restart that drops it as idle (the relay was down for a day).
  expect((await register('ses_bare3', ATTACKER_IP, ownerKey())).status).toBe(201)
  store.getSession('ses_bare3')!.last_seen = Date.now() - config.orphanReapMs - 60_000
  const snapshot = store.snapshot()
  await close()
  const restored = new Store()
  restored.restore(snapshot)
  await listen(restored)
  expect((await register('ses_bare3', OWNER_IP)).status).toBe(201)
})

test("an owner's registration no bridge took up keeps the reservation its last share earned", async () => {
  const t = clock()
  const K = ownerKey()
  const share = async (id: string) => {
    const r = await register(id, OWNER_IP, K)
    expect(r.status).toBe(201)
    await connect(id, r.body.bridge_token!)
    return r.body.bridge_token!
  }
  const refusedToOthers = async (id: string) => {
    expect((await register(id, ATTACKER_IP)).status).toBe(409)
    expect((await register(id, ATTACKER_IP, ownerKey())).status).toBe(409)
  }

  // A real share, stopped; the owner starts again, but that bridge never dials
  // in (a crash between the POST and the connection) and the reaper removes it.
  expect(await remove('ses_keep1', await share('ses_keep1'))).toBe(204)
  expect((await register('ses_keep1', OWNER_IP, K)).status).toBe(201)
  t.advance(config.unboundReapMs + 60_000)
  expect(store.reapOrphans(config.orphanReapMs)).toEqual(['ses_keep1'])
  await refusedToOthers('ses_keep1')

  // Or its dial failed and it deleted the registration itself.
  expect(await remove('ses_keep2', await share('ses_keep2'))).toBe(204)
  const retry = await register('ses_keep2', OWNER_IP, K)
  expect(await remove('ses_keep2', retry.body.bridge_token!)).toBe(204)
  await refusedToOthers('ses_keep2')

  // A live share whose bridge died, replaced by a registration that never binds.
  await share('ses_keep3')
  expect((await register('ses_keep3', OWNER_IP, K)).status).toBe(201)
  t.advance(config.unboundReapMs + 60_000)
  expect(store.reapOrphans(config.orphanReapMs)).toEqual(['ses_keep3'])
  await refusedToOthers('ses_keep3')

  // And across a restart while such a registration was waiting.
  expect(await remove('ses_keep4', await share('ses_keep4'))).toBe(204)
  expect((await register('ses_keep4', OWNER_IP, K)).status).toBe(201)
  const snapshot = store.snapshot()
  await close()
  const restored = new Store()
  restored.restore(snapshot)
  await listen(restored)
  t.advance(config.unboundReapMs + 60_000)
  expect(store.reapOrphans(config.orphanReapMs)).toEqual(['ses_keep4'])
  await refusedToOthers('ses_keep4')

  for (const id of ['ses_keep1', 'ses_keep2', 'ses_keep3', 'ses_keep4']) {
    expect((await register(id, OWNER_IP, K)).status).toBe(201)
  }
})
