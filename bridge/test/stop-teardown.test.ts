import { afterAll, beforeAll, expect, test } from 'vitest'
import { createServer, type Server } from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
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
  // SIGTERM, exactly like the CLI's signal handler does.
  const child = spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)"],
    { stdio: 'ignore' },
  )
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
