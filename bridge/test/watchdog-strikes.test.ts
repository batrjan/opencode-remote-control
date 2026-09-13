import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import { startServer } from '../../relay/src/server'
import { opencodeAuthHeader } from '../src/config'
import { startBridge } from '../src/index'
import { RelayClient } from '../src/relay'

/**
 * One slow health probe must not end a share.
 *
 * The watchdog polled the local opencode server every 10 s and stopped on the
 * first probe that failed — with the 1.5 s timeout meant for scanning ports
 * during detection, where a stale listener must not stall the scan. An opencode
 * server that took longer than that to answer once (busy with the very prompt a
 * viewer had just sent, or the bridge's own event loop stalling) was treated
 * like a dead one: the bridge revoked the code and every viewer token, killed
 * the `opencode serve` it had spawned, and exited with a bare
 * "Remote control stopped." — which the plugin path writes only to its private
 * log. Reproduced against the real bundle: a single 2 s stall in a server that
 * was healthy again a moment later ended the share 1.5 s into the probe.
 *
 * The watchdog now gives a probe its own, longer deadline, ends the share only
 * after several failed probes in a row, and says why — on stderr, and in the
 * CLI's last line.
 */

const API_KEY = 'test-relay-key'
process.env.RELAY_API_KEY = API_KEY
// Short probe deadline so a "stalled" server is cheap to simulate. The strike
// count is left at its default on purpose.
const PROBE_TIMEOUT_MS = 200
process.env.REMOTE_CONTROL_WATCHDOG_TIMEOUT_MS = String(PROBE_TIMEOUT_MS)
/** How late a slow health answer arrives: past the probe deadline, and past the 1.5 s the watchdog used to allow. */
const SLOW_MS = 2000

const BUNDLE = fileURLToPath(new URL('../../plugin/bridge/remote-control-bridge.cjs', import.meta.url))

let relay: Server
let relayUrl: string
let opencode: Server
let opencodePort: number

/** How the mock opencode answers /global/health. */
let healthMode: 'ok' | 'slow' | 'down' = 'ok'
/** Answer this many upcoming health probes late, then go back to healthMode. */
let slowNext = 0
let healthProbes = 0

function json(res: import('node:http').ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** A stand-in for the `opencode serve` a bridge spawned: a child that stays alive until killed. */
function spawnDummyServer(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
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

/** What `promise` resolved with within `ms`, or 'pending' — a failing test reads as a value, not a vitest timeout. */
async function settleWithin<T>(promise: Promise<T>, ms: number): Promise<{ value: T } | 'pending'> {
  let timer: NodeJS.Timeout | undefined
  const expired = new Promise<'pending'>((resolve) => {
    timer = setTimeout(() => resolve('pending'), ms)
  })
  try {
    return await Promise.race([promise.then((value) => ({ value })), expired])
  } finally {
    clearTimeout(timer)
  }
}

async function until(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return check()
}

beforeAll(async () => {
  opencode = createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    // Same basic auth as the real server, so detect.test.ts (parallel worker)
    // never mistakes this mock for a healthy opencode.
    if (req.headers.authorization !== opencodeAuthHeader()) return json(res, 401, { error: 'unauthorized' })
    if (url.pathname === '/global/health') {
      healthProbes++
      if (healthMode === 'down') return json(res, 503, { healthy: false })
      if (slowNext > 0 || healthMode === 'slow') {
        if (slowNext > 0) slowNext--
        const timer = setTimeout(() => json(res, 200, { healthy: true }), SLOW_MS)
        res.on('close', () => clearTimeout(timer)) // the probe gave up: never write to a dead socket
        return
      }
      return json(res, 200, { healthy: true })
    }
    if (url.pathname === '/event') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(': connected\n\n')
      return
    }
    json(res, 404, { error: 'not found' })
  })
  await new Promise<void>((resolve) => opencode.listen(0, '127.0.0.1', resolve))
  opencodePort = (opencode.address() as AddressInfo).port
  relay = await startServer(0)
  relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`
})

beforeEach(() => {
  healthMode = 'ok'
  slowNext = 0
  healthProbes = 0
  vi.restoreAllMocks()
})

afterAll(async () => {
  relay.closeAllConnections()
  await new Promise((resolve) => relay.close(resolve))
  opencode.closeAllConnections()
  await new Promise((resolve) => opencode.close(resolve))
})

test('a single health probe that times out neither ends the share nor kills the server it spawned', async () => {
  const server = spawnDummyServer()
  const handle = await startBridge(relayUrl, API_KEY, {
    sessionId: 'sess-wd-once',
    healthIntervalMs: 100,
    serverSpawner: async () => ({ port: opencodePort, spawned: server }),
  })
  try {
    slowNext = 1
    // Long enough for the slow answer to land, and for many ticks after it.
    expect(await settleWithin(handle.closed, SLOW_MS + 800)).toBe('pending')
    expect(slowNext).toBe(0) // the stall really was probed…
    expect(healthProbes).toBeGreaterThan(3) // …and the probes after it were answered
    expect((await new RelayClient(relayUrl, API_KEY).getSession('sess-wd-once')).status).toBe(200)
    expect(server.exitCode).toBeNull()
    expect(server.signalCode).toBeNull()
  } finally {
    await handle.stop()
    server.kill('SIGKILL')
    await waitForExit(server)
  }
})

test('a server that keeps failing its probes ends the share after the strike limit, and the bridge says why', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const server = spawnDummyServer()
  const handle = await startBridge(relayUrl, API_KEY, {
    sessionId: 'sess-wd-dead',
    healthIntervalMs: 100,
    serverSpawner: async () => ({ port: opencodePort, spawned: server }),
  })
  try {
    healthMode = 'slow'
    const outcome = await settleWithin(handle.closed, 5000)
    expect(outcome).not.toBe('pending')
    const reason = outcome === 'pending' ? undefined : outcome.value
    expect(reason).toMatch(/local opencode server stopped responding/)
    expect(reason).toContain(`3 health probes in a row failed: no answer within ${PROBE_TIMEOUT_MS} ms`)
    expect(healthProbes).toBeGreaterThanOrEqual(3)
    const warned = warn.mock.calls.map((args) => args.join(' ')).join('\n')
    expect(warned).toContain(`failed 3 health probes in a row (no answer within ${PROBE_TIMEOUT_MS} ms)`)
    expect((await new RelayClient(relayUrl, API_KEY).getSession('sess-wd-dead')).status).toBe(404)
    // The share's lifetime owns the server it spawned.
    expect(await waitForExit(server)).toBe(true)
  } finally {
    await handle.stop()
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL')
  }
})

/**
 * The same end as the owner reads it: the committed bundle, started the way
 * the plugin starts it, prints the cause as its last line instead of a bare
 * "Remote control stopped.", and the warning on stderr.
 */
test('the CLI names the cause when the watchdog ends the share', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'rc-watchdog-'))
  const bridge = spawn(
    process.execPath,
    [BUNDLE, 'start', '--relay', relayUrl, '--port', String(opencodePort), '--session-id', 'sess-wd-cli'],
    {
      env: {
        ...process.env,
        HOME: home,
        REMOTE_CONTROL_WATCHDOG_INTERVAL_MS: '100',
        REMOTE_CONTROL_WATCHDOG_TIMEOUT_MS: String(PROBE_TIMEOUT_MS),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let stdout = ''
  let stderr = ''
  bridge.stdout!.on('data', (chunk) => (stdout += chunk))
  bridge.stderr!.on('data', (chunk) => (stderr += chunk))
  try {
    expect(await until(() => stdout.includes('CODE:') || bridge.exitCode !== null, 10_000)).toBe(true)
    expect(stdout).toContain('CODE:')
    healthMode = 'down'
    expect(await waitForExit(bridge, 10_000)).toBe(true)
    expect(bridge.exitCode).toBe(0)
    const last = stdout.trim().split('\n').at(-1)
    expect(last).toBe(
      'Remote control stopped: the local opencode server stopped responding (3 health probes in a row failed: HTTP 503).',
    )
    expect(stderr).toContain('failed 3 health probes in a row (HTTP 503)')
    expect((await new RelayClient(relayUrl, API_KEY).getSession('sess-wd-cli')).status).toBe(404)
  } finally {
    if (bridge.exitCode === null && bridge.signalCode === null) bridge.kill('SIGKILL')
    rmSync(home, { recursive: true, force: true })
  }
}, 30_000)
