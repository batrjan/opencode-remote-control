import { afterAll, afterEach, beforeAll, expect, test } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { startServer } from '../../relay/src/server'
import { opencodeAuthHeader } from '../src/config'
import { startBridge, stopBridge, type BridgeHandle } from '../src/index'
import { RelayClient } from '../src/relay'
import { loadSessionState, saveSessionState } from '../src/state'

/**
 * Two starts of one session from one install that overlap (two TUIs, a retry
 * while the first start still runs) must leave the state file to the share
 * that is live on the relay.
 *
 * A start only refuses a share this machine runs once that share's state file
 * exists, and the file is written after registration — so both starts can find
 * nothing, and both register. The relay lets this install's owner_key replace
 * its own registration, so the later one wins and the earlier one fails. A
 * failing start used to remove the state file under the session's name without
 * looking whose it was: the winner's. Its share stayed live with every viewer,
 * but `stop` answered "not shared from this machine" and nothing local could
 * end it any more. The same went for a start ending a dead earlier share while
 * a concurrent start had already replaced that share's state with its own.
 *
 * Stand-ins: an in-process relay built from source and an opencode server over
 * node:http, both able to hold a request until the test lets it through, which
 * is what pins the two starts to the interleaving. HOME is a temp dir.
 */

const API_KEY = 'test-relay-key'
process.env.RELAY_API_KEY = API_KEY

let relay: Server
let relayUrl: string
let opencode: Server
let opencodeUrl: string
let root: string
let savedHome: string | undefined
const handles: BridgeHandle[] = []

/** One request the test holds until it calls release(). */
interface Hold {
  /** Resolves once the request has arrived and is being held. */
  arrived: Promise<void>
  release(): void
}

interface PendingHold {
  matches: (req: IncomingMessage) => boolean
  reached: () => void
  opened: Promise<void>
  release: () => void
}

/** Holds not yet consumed, in order: each matching request takes the first that fits. */
const holds: PendingHold[] = []
/** Registrations the relay refuses with 503, as the next N POSTs come in. */
let refuseRegistrations = 0

function holdNext(matches: (req: IncomingMessage) => boolean): Hold {
  let reached!: () => void
  let release!: () => void
  const arrived = new Promise<void>((resolve) => (reached = resolve))
  const opened = new Promise<void>((resolve) => (release = resolve))
  holds.push({ matches, reached, opened, release })
  return { arrived, release }
}

/** Wait here while a hold matches `req`; resolves at once otherwise. */
async function passHolds(req: IncomingMessage): Promise<void> {
  const index = holds.findIndex((hold) => hold.matches(req))
  if (index === -1) return
  const [hold] = holds.splice(index, 1)
  hold!.reached()
  await hold!.opened
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

const sessionFetch = (id: string) => (req: IncomingMessage) =>
  req.method === 'GET' && req.url === `/session/${id}`
const bridgeUpgrade = (id: string) => (req: IncomingMessage) =>
  (req.url ?? '').startsWith(`/bridge?session_id=${id}`)
const relayDelete = (id: string) => (req: IncomingMessage) =>
  req.method === 'DELETE' && req.url === `/api/sessions/${id}`

beforeAll(async () => {
  savedHome = process.env.HOME
  root = mkdtempSync(path.join(tmpdir(), 'rc-concurrent-start-'))
  mkdirSync(path.join(root, 'home'))
  process.env.HOME = path.join(root, 'home')
  opencode = createServer(async (req, res) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    if (req.headers.authorization !== opencodeAuthHeader()) return json(res, 401, { error: 'unauthorized' })
    await passHolds(req)
    if (url.pathname === '/global/health') return json(res, 200, { healthy: true })
    if (url.pathname === '/event') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(': connected\n\n')
      return
    }
    const m = /^\/session\/([^/]+)$/.exec(url.pathname)
    if (m) return json(res, 200, { id: decodeURIComponent(m[1]!), directory: root, title: 'concurrent start' })
    json(res, 404, { error: 'not found' })
  })
  await new Promise<void>((resolve) => opencode.listen(0, '127.0.0.1', resolve))
  opencodeUrl = `http://127.0.0.1:${(opencode.address() as AddressInfo).port}`

  relay = await startServer(0)
  relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`
  // Put the holds in front of the relay's own handlers: the API app, and the
  // bridge WebSocket server listening for upgrades.
  const [app] = relay.listeners('request') as Array<(req: IncomingMessage, res: ServerResponse) => void>
  relay.removeAllListeners('request')
  relay.on('request', async (req: IncomingMessage, res: ServerResponse) => {
    await passHolds(req)
    if (req.method === 'POST' && req.url === '/api/sessions' && refuseRegistrations > 0) {
      refuseRegistrations--
      return json(res, 503, { error: 'unavailable' })
    }
    app!.call(relay, req, res)
  })
  const [upgrade] = relay.listeners('upgrade') as Array<(req: IncomingMessage, socket: Duplex, head: Buffer) => void>
  relay.removeAllListeners('upgrade')
  relay.on('upgrade', async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    await passHolds(req)
    upgrade!.call(relay, req, socket, head)
  })
})

afterEach(async () => {
  // A test that failed half-way must not leave a start waiting forever.
  for (const hold of holds.splice(0)) hold.release()
  refuseRegistrations = 0
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

/** A start whose promise the test settles later; a handle it yields is still stopped. */
function launch(sessionId: string): Promise<BridgeHandle> {
  const pending = startBridge(relayUrl, API_KEY, { opencodeUrl, sessionId })
  pending.then(
    (handle) => handles.push(handle),
    () => {},
  )
  return pending
}

/** The pid of a process that has exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await new Promise((resolve) => child.once('exit', resolve))
  return child.pid!
}

test('a start whose registration a concurrent start replaced fails without removing that share state', async () => {
  const id = 'ses_raceWebSocket1'
  const fetchedFirst = holdNext(sessionFetch(id))
  const fetchedSecond = holdNext(sessionFetch(id))
  const dialFirst = holdNext(bridgeUpgrade(id))

  const first = launch(id)
  await fetchedFirst.arrived
  const second = launch(id)
  await fetchedSecond.arrived
  // Both have looked for an earlier share of the session on this machine and
  // found none. The first registers, writes its state and dials the relay.
  fetchedFirst.release()
  await dialFirst.arrived
  expect(loadSessionState(id)?.pid).toBe(process.pid)

  // The second registers with the same owner_key, replacing the first's
  // registration before its bridge got through, and writes its own state.
  fetchedSecond.release()
  const live = await second
  expect(loadSessionState(id)?.access_code).toBe(live.access_code)

  // The first's bridge token is gone from the relay.
  dialFirst.release()
  await expect(first).rejects.toThrow(/HTTP 401/)

  expect(loadSessionState(id)?.access_code).toBe(live.access_code)
  expect((await new RelayClient(relayUrl).getSession(id)).body?.bridge_connected).toBe(true)
  // And `stop` still ends the live share: the relay confirms (no warning), and
  // the bridge is told its session is gone.
  await expect(stopBridge(relayUrl, id, API_KEY)).resolves.toBeUndefined()
  expect(await live.closed).toMatch(/relay ended the session/)
  expect((await new RelayClient(relayUrl).getSession(id)).status).toBe(404)
})

test('a start that ended a dead earlier share leaves the state a concurrent start wrote meanwhile', async () => {
  const id = 'ses_raceSettle1'
  // A share whose bridge died without a word, its state still on disk.
  saveSessionState({
    session_id: id,
    access_code: 'DEADCODE',
    bridge_token: 'token-of-a-bridge-that-died',
    relay: relayUrl,
    started_at: Date.now() - 60_000,
    pid: await deadPid(),
  })
  const endingDead = holdNext(relayDelete(id))

  // The first start is ending the dead share on the relay...
  const first = launch(id)
  await endingDead.arrived
  // ...while the second ends it too, registers and writes its own state.
  const live = await launch(id)
  expect(loadSessionState(id)?.access_code).toBe(live.access_code)

  // The first then fails to register (the relay is briefly unavailable).
  refuseRegistrations = 1
  endingDead.release()
  await expect(first).rejects.toThrow(/503/)

  expect(loadSessionState(id)?.access_code).toBe(live.access_code)
  expect((await new RelayClient(relayUrl).getSession(id)).body?.bridge_connected).toBe(true)
})
