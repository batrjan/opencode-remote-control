import { afterAll, afterEach, beforeAll, expect, test } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { startServer } from '../../relay/src/server'
import { opencodeAuthHeader } from '../src/config'
import { startBridge, type BridgeHandle } from '../src/index'
import { RelayClient } from '../src/relay'
import { clearSessionState, latestSessionState, loadSessionState, ownerKey } from '../src/state'

/**
 * A share link names the opencode session id, and the owner registers that
 * same id again each time they share the conversation. The relay used to hand
 * a freed id to whoever asked first: anyone holding an old link could register
 * it the moment the owner stopped, keep it alive with a connected socket, and
 * the owner's next start failed with "relay createSession failed: 409" and no
 * token to clear it. A start after a bridge died without its state file (the
 * one place its token lived) hit the same wall for a day.
 *
 * The bridge now sends an owner_key with every registration: an HMAC of the
 * session id under a secret created once per install (owner.key, 0600, beside
 * the state files). The relay reserves the id for that key after the share
 * ends and lets the same key replace its own registration. A live share this
 * machine still records is still refused locally, before the relay is asked —
 * the relay would otherwise take it over under its viewers.
 *
 * Stand-ins: an in-process relay built from source and an opencode server over
 * node:http. HOME is a temp dir, so no real state or key is ever touched.
 */

const API_KEY = 'test-relay-key'
process.env.RELAY_API_KEY = API_KEY
const PICKED = 'ses_ownerPicked1'

let relay: Server
let relayUrl: string
let opencode: Server
let opencodeUrl: string
let root: string
let savedHome: string | undefined
const handles: BridgeHandle[] = []

function json(res: import('node:http').ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

beforeAll(async () => {
  savedHome = process.env.HOME
  root = mkdtempSync(path.join(tmpdir(), 'rc-owner-key-'))
  mkdirSync(path.join(root, 'home'))
  process.env.HOME = path.join(root, 'home')
  opencode = createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    if (req.headers.authorization !== opencodeAuthHeader()) return json(res, 401, { error: 'unauthorized' })
    if (url.pathname === '/global/health') return json(res, 200, { healthy: true })
    if (url.pathname === '/event') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(': connected\n\n')
      return
    }
    if (url.pathname === '/session') return json(res, 200, [{ id: PICKED, directory: root, title: 'picked', time: { created: 1 } }])
    const m = /^\/session\/([^/]+)$/.exec(url.pathname)
    if (m) return json(res, 200, { id: decodeURIComponent(m[1]!), directory: root, title: 'owner key' })
    json(res, 404, { error: 'not found' })
  })
  await new Promise<void>((resolve) => opencode.listen(0, '127.0.0.1', resolve))
  opencodeUrl = `http://127.0.0.1:${(opencode.address() as AddressInfo).port}`
  relay = await startServer(0)
  relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`
})

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.stop()
})

afterAll(async () => {
  relay.closeAllConnections()
  await new Promise((resolve) => relay.close(resolve))
  opencode.closeAllConnections()
  await new Promise((resolve) => opencode.close(resolve))
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  rmSync(root, { recursive: true, force: true })
})

async function start(sessionId?: string): Promise<BridgeHandle> {
  const handle = await startBridge(relayUrl, API_KEY, { opencodeUrl, ...(sessionId ? { sessionId } : {}) })
  handles.push(handle)
  return handle
}

test('the owner key is one install secret, stable per session id and different between them', () => {
  const a = ownerKey('ses_keyA')
  expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(ownerKey('ses_keyA')).toBe(a)
  expect(ownerKey('ses_keyB')).not.toBe(a)

  const stateDir = path.join(root, 'home', '.agents', 'skills', 'remote-control', 'state')
  const file = path.join(stateDir, 'owner.key')
  expect(readFileSync(file).length).toBe(32)
  if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
  // Not a state file: stop/status pick the newest *.json and must never read it.
  expect(readdirSync(stateDir).filter((f) => f.endsWith('.json'))).toEqual([])
  expect(latestSessionState()).toBeUndefined()
})

test('after stop, nobody else can register the session, and the owner shares it again', async () => {
  const first = await start('ses_ownerStop1')
  await first.stop()
  expect(loadSessionState('ses_ownerStop1')).toBeUndefined()

  // Someone holding the old link (no key: it never left this machine).
  await expect(new RelayClient(relayUrl).createSession('ses_ownerStop1', '/elsewhere', 'squat')).rejects.toThrow(/409/)

  const again = await start('ses_ownerStop1')
  expect(again.access_code).toBeTruthy()
  expect(again.access_code).not.toBe(first.access_code)
  expect((await new RelayClient(relayUrl).getSession('ses_ownerStop1')).status).toBe(200)
})

test('a registration of this install whose state file is gone is taken back by the next start', async () => {
  // A bridge that died without a word, and the state holding its token went
  // with it: only this install's key still ties the id to this machine.
  const earlier = await new RelayClient(relayUrl).createSession('ses_ownerLost1', root, 'lost', ownerKey('ses_ownerLost1'))
  expect(loadSessionState('ses_ownerLost1')).toBeUndefined()

  const handle = await start('ses_ownerLost1')
  expect(handle.access_code).not.toBe(earlier.access_code)
  expect(await new RelayClient(relayUrl).deleteSession('ses_ownerLost1', earlier.bridge_token)).toBe(404)
})

test('a share replaced by a later start of the same install ends without removing the new share state', async () => {
  const replaced = await start('ses_ownerLive1')
  clearSessionState('ses_ownerLive1')

  const current = await start('ses_ownerLive1')
  expect(await replaced.closed).toMatch(/relay ended the session/)
  const state = loadSessionState('ses_ownerLive1')
  expect(state?.access_code).toBe(current.access_code)
  expect(state?.pid).toBe(process.pid)
})

test('a start that picks a session this machine is sharing is refused, not a takeover of that share', async () => {
  const live = await start(PICKED)
  await expect(start()).rejects.toThrow(/already shared from this machine/)
  expect(loadSessionState(PICKED)?.access_code).toBe(live.access_code)
  expect((await new RelayClient(relayUrl).getSession(PICKED)).body?.bridge_connected).toBe(true)
})
