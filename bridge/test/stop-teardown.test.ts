import { afterAll, beforeAll, expect, test } from 'vitest'
import { createServer, type Server } from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { startServer } from '../../relay/src/server'
import { opencodeAuthHeader } from '../src/config'
import { startBridge, stopBridge } from '../src/index'
import { loadSessionState, clearSessionState, saveSessionState } from '../src/state'

/**
 * Teardown contract for `stop`: it must not only delete the relay session but
 * also terminate the long-running `start` process and the `opencode serve`
 * that process spawned. Before this, `stop` cleared the relay session and the
 * state file while both processes kept running (holding the server's port).
 */

const API_KEY = 'test-relay-key'
process.env.RELAY_API_KEY = API_KEY

let relay: Server
let relayUrl: string
let opencode: Server
let opencodeUrl: string

function json(res: import('node:http').ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** A stand-in for `opencode serve`: a child that stays alive until killed. */
function spawnDummyServer(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
}

/**
 * A stand-in for a `start` running in another process — and it has to LOOK like
 * one. `stop` no longer signals a bare pid: it reads the pid's command line and
 * refuses anything that is not a bridge entry point, because the state file
 * outlives a bridge killed with -9 and the OS recycles pids. So the stand-in is
 * spawned from a real file named like the shipped bundle rather than from
 * `node -e`, which is exactly the shape that check is there to refuse.
 */
function spawnDummyBridge(): ChildProcess {
  const dir = mkdtempSync(path.join(tmpdir(), 'bridge-stop-'))
  const entry = path.join(dir, 'remote-control-bridge.cjs')
  writeFileSync(entry, "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)\n")
  spawnedBridgeDirs.push(dir)
  return spawn(process.execPath, [entry, 'start', '--relay', 'http://127.0.0.1:1'], { stdio: 'ignore' })
}

const spawnedBridgeDirs: string[] = []

/**
 * A stand-in for the `opencode serve` a bridge spawned — named like one, since
 * `stop` only signals a recorded server pid whose command line is an
 * `opencode serve` (the same recycled-pid guard the bridge pid gets).
 */
function spawnDummyOpencodeServe(): ChildProcess {
  const dir = mkdtempSync(path.join(tmpdir(), 'bridge-stop-serve-'))
  const entry = path.join(dir, 'opencode')
  writeFileSync(entry, "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)\n")
  spawnedBridgeDirs.push(dir)
  return spawn(process.execPath, [entry, 'serve'], { stdio: 'ignore' })
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForExit(child: ChildProcess, timeoutMs = 5000): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true
  return await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

beforeAll(async () => {
  opencode = createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    if (req.headers.authorization !== opencodeAuthHeader()) return json(res, 401, { error: 'unauthorized' })
    if (url.pathname === '/global/health') return json(res, 200, { healthy: true })
    if (url.pathname === '/event') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(': connected\n\n')
      return
    }
    json(res, 404, { error: 'not found' })
  })
  await new Promise<void>((resolve) => opencode.listen(0, '127.0.0.1', resolve))
  opencodeUrl = `http://127.0.0.1:${(opencode.address() as AddressInfo).port}`
  relay = await startServer(0)
  relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`
})

afterAll(async () => {
  relay.closeAllConnections()
  await new Promise((resolve) => relay.close(resolve))
  opencode.closeAllConnections()
  await new Promise((resolve) => opencode.close(resolve))
  for (const dir of spawnedBridgeDirs) rmSync(dir, { recursive: true, force: true })
})

test('start records its own pid so another process can stop it', async () => {
  const handle = await startBridge(relayUrl, API_KEY, { opencodeUrl, sessionId: 'sess-pid' })
  try {
    expect(loadSessionState('sess-pid')?.pid).toBe(process.pid)
  } finally {
    await handle.stop()
    clearSessionState('sess-pid')
  }
})

test('stop kills the opencode server the bridge spawned', async () => {
  const dummy = spawnDummyServer()
  const port = Number(new URL(opencodeUrl).port)
  const handle = await startBridge(relayUrl, API_KEY, {
    sessionId: 'sess-spawned',
    serverSpawner: async () => ({ port, spawned: dummy }),
  })
  expect(alive(dummy.pid!)).toBe(true)
  await handle.stop()
  expect(await waitForExit(dummy)).toBe(true)
  expect(alive(dummy.pid!)).toBe(false)
})

test('stop signals the bridge process recorded in the state file', async () => {
  // Stand in for a `start` running in another process: a child that exits on
  // SIGTERM, exactly like the CLI's signal handler does, launched from a
  // bridge-shaped entry point so `stop`'s pid-identity check recognises it.
  const child = spawnDummyBridge()
  await new Promise((resolve) => setTimeout(resolve, 200))
  const created = await fetch(`${relayUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ session_id: 'sess-remote', directory: '/path', title: 't' }),
  })
  const body = (await created.json()) as { access_code: string; bridge_token: string }
  saveSessionState({
    session_id: 'sess-remote',
    access_code: body.access_code,
    bridge_token: body.bridge_token,
    relay: relayUrl,
    started_at: Date.now(),
    pid: child.pid,
  })

  await stopBridge(relayUrl, 'sess-remote', API_KEY)

  expect(await waitForExit(child)).toBe(true)
  expect(alive(child.pid!)).toBe(false)
  expect(loadSessionState('sess-remote')).toBeUndefined()
})

test('stop tolerates a stale pid and never signals its own process', async () => {
  // A pid that is certainly not running (and, separately, our own pid) must
  // not make stop throw or kill the caller.
  const dead = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
  await waitForExit(dead)
  const stalePid = dead.pid!
  for (const pid of [stalePid, process.pid]) {
    const created = await fetch(`${relayUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ session_id: `sess-stale-${pid}`, directory: '/path', title: 't' }),
    })
    const body = (await created.json()) as { access_code: string; bridge_token: string }
    saveSessionState({
      session_id: `sess-stale-${pid}`,
      access_code: body.access_code,
      bridge_token: body.bridge_token,
      relay: relayUrl,
      started_at: Date.now(),
      pid,
    })
    await expect(stopBridge(relayUrl, `sess-stale-${pid}`, API_KEY)).resolves.toBeUndefined()
  }
  expect(alive(process.pid)).toBe(true)
})

test('stop never signals a live process that is not a bridge (recycled pid)', async () => {
  // The case the pid check exists for: the bridge died without cleaning up, the
  // OS handed its number to something else, and `stop` runs against a state
  // file that still names it. Signalling here kills a stranger's process.
  const stranger = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  await new Promise((resolve) => setTimeout(resolve, 200))
  const created = await fetch(`${relayUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ session_id: 'sess-recycled', directory: '/path', title: 't' }),
  })
  const body = (await created.json()) as { access_code: string; bridge_token: string }
  saveSessionState({
    session_id: 'sess-recycled',
    access_code: body.access_code,
    bridge_token: body.bridge_token,
    relay: relayUrl,
    started_at: Date.now(),
    pid: stranger.pid,
  })

  await stopBridge(relayUrl, 'sess-recycled', API_KEY)

  // The relay session and the state file are gone — stop still did its job —
  // but the innocent process is untouched.
  expect(loadSessionState('sess-recycled')).toBeUndefined()
  expect(alive(stranger.pid!)).toBe(true)
  stranger.kill()
  await waitForExit(stranger)
})

/**
 * `stop` while the relay cannot be told. `stop` used to put every bit of local
 * teardown behind a successful relay DELETE: a relay restarting behind nginx
 * (502), a relay that is down or unreachable from the owner's network (refused)
 * or one that accepts the connection and never answers made it fail — or hang
 * with no bound at all — before it cleared the state file or signalled a single
 * process. The bridge meanwhile treats all of that as a transient outage and
 * keeps re-dialling; the relay persists sessions, so once it was back the share
 * came back with it, same access code, with the owner told only "stop failed".
 *
 * The owner asked to stop: the share has to end on this machine whatever the
 * relay says. Once the bridge and the state file (the only copies of the
 * bridge_token) are gone, nothing can re-attach the relay's record to a bridge.
 */
async function relayStandin(kind: '502' | 'refused' | 'hang'): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_req, res) => {
    if (kind === 'hang') return // accept, read the request, never answer
    res.writeHead(502, { 'Content-Type': 'text/html' })
    res.end('<html><body><h1>502 Bad Gateway</h1></body></html>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const close = async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
  // Connection refused: a port that was just bound and released again.
  if (kind === 'refused') await close()
  return { url, close: kind === 'refused' ? async () => {} : close }
}

for (const [outage, kind, reason] of [
  ['the relay answers 502 (restarting behind nginx)', '502', /502/],
  ['the relay refuses the connection (down / unreachable)', 'refused', /unreachable/],
  ['the relay accepts the connection and never answers', 'hang', /did not answer/],
] as const) {
  test(`stop ends the share on this machine when ${outage}`, async () => {
    const relayDown = await relayStandin(kind)
    const bridge = spawnDummyBridge()
    const server = spawnDummyOpencodeServe()
    await new Promise((resolve) => setTimeout(resolve, 200))
    const id = `sess-relay-down-${kind}`
    saveSessionState({
      session_id: id,
      access_code: 'XXXXXX',
      bridge_token: 'token-the-relay-never-sees',
      relay: relayDown.url,
      started_at: Date.now(),
      pid: bridge.pid,
      server_pid: server.pid,
    })
    try {
      const outcome = await Promise.race([
        stopBridge(relayDown.url, id).then(
          (warning) => ({ warning }),
          (err: Error) => ({ error: err.message }),
        ),
        new Promise((resolve) => setTimeout(() => resolve('still pending after 8 s'), 8_000)),
      ])
      // Settles, and does not fail: the share did end, which is what was asked.
      expect(outcome).toEqual({ warning: expect.stringMatching(reason) })
      // ...but it must not pass for a clean stop: the relay was never told.
      expect((outcome as { warning: string }).warning).toMatch(/relay could not be told/)
      expect(await waitForExit(bridge)).toBe(true)
      expect(await waitForExit(server)).toBe(true)
      expect(loadSessionState(id)).toBeUndefined()
    } finally {
      for (const child of [bridge, server]) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      clearSessionState(id)
      await relayDown.close()
    }
  }, 20_000)
}
