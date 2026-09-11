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
