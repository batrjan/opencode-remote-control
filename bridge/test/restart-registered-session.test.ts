import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import { startServer } from '../../relay/src/server'
import { opencodeAuthHeader } from '../src/config'
import { startBridge } from '../src/index'
import { RelayClient } from '../src/relay'
import { loadSessionState, saveSessionState, type SessionState } from '../src/state'
// @ts-expect-error — the plugin is plain ESM JavaScript, no types.
import { failedLogPath, logPath, runAction } from '../../plugin/bridge-runner.js'

/**
 * Starting a session that the relay still holds must say what is going on, and
 * take the session back when the share holding it is dead.
 *
 * A bridge that dies without running its teardown (SIGKILL, a crash, a reboot)
 * leaves its registration on the relay, which refuses a second registration of
 * the same id and expires the old one only after a day without activity. Every
 * `start` of that session then failed with a bare "relay createSession failed:
 * 409" and nothing said that `stop` (which still had the bridge_token in the
 * state file) would clear it. The same bare 409 greeted a second start while
 * the first share was still live — and on the plugin path that start had
 * already truncated bridge.log, the one file holding the live share's URL and
 * code. `status` meanwhile reported a share whose bridge was gone as "active"
 * with exit code 0. Reproduced against a relay built from source, the committed
 * bundle and the real plugin runner.
 *
 * Now a share this machine recorded is checked first: a bridge that still runs
 * is left alone and named, with the way to end it; a dead one is ended on the
 * relay with its own token, and the start goes ahead. `status` names a dead
 * bridge and fails.
 *
 * Stand-ins: an in-process relay, an opencode server over node:http, processes
 * whose command lines read like a bridge or an `opencode serve`, and, for the
 * CLI and plugin paths, a fake `lsof` and `opencode` on PATH so no real server
 * on the machine is ever touched. POSIX only.
 */

const API_KEY = 'test-relay-key'
process.env.RELAY_API_KEY = API_KEY
const BUNDLE = fileURLToPath(new URL('../../plugin/bridge/remote-control-bridge.cjs', import.meta.url))

let relay: Server
let relayUrl: string
let opencode: Server
let opencodeUrl: string
let opencodePort: number
let root: string
let home: string
let pidLog: string
const saved: Record<string, string | undefined> = {}
const ENV_KEYS = ['HOME', 'PATH', 'OPENCODE_REMOTE_CONTROL_RELAY', 'REMOTE_CONTROL_START_TIMEOUT_MS'] as const
const children: ChildProcess[] = []
/** Registrations made by the tests themselves, removed after each test (the relay caps active sessions per IP). */
const registrations: { id: string; token: string }[] = []

function json(res: import('node:http').ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function alive(pid: number | undefined): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return await check()
}

/** A long-running process whose command line is `node <root>/<dir>/<name> ...args`. */
function lookalike(dir: string, name: string, args: string[] = []): ChildProcess {
  const file = path.join(root, dir, name)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, 'setInterval(() => {}, 1 << 30)\n')
  const child = spawn(process.execPath, [file, ...args], { stdio: 'ignore' })
  children.push(child)
  return child
}

/** The pid of a process that has already exited: what a state file names after a crash or a reboot. */
async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await new Promise((resolve) => child.once('exit', resolve))
  return child.pid!
}

async function register(id: string) {
  const session = await new RelayClient(relayUrl, API_KEY).createSession(id, root, 'earlier share')
  registrations.push({ id, token: session.bridge_token })
  return session
}

function earlierState(id: string, session: { access_code: string; bridge_token: string }, extra: Partial<SessionState>) {
  const state: SessionState = {
    session_id: id,
    access_code: session.access_code,
    bridge_token: session.bridge_token,
    relay: relayUrl,
    started_at: Date.now(),
    ...extra,
  }
  saveSessionState(state)
  return state
}

/** Logs of starts that never became bridge.log. */
function startLogs(): string[] {
  return readdirSync(path.dirname(logPath())).filter((file) => file.startsWith('bridge.starting-'))
}

async function relayStatus(id: string): Promise<number> {
  return (await new RelayClient(relayUrl).getSession(id)).status
}

/** The committed bundle, the way the plugin runs `status`. */
function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [BUNDLE, ...args], { env: { ...process.env, ...env }, timeout: 15_000 }, (err, stdout) =>
      resolve({ code: err ? Number((err as { code?: unknown }).code ?? 1) : 0, stdout: String(stdout) }),
    )
  })
}

beforeAll(async () => {
  for (const key of ENV_KEYS) saved[key] = process.env[key]
  root = mkdtempSync(path.join(tmpdir(), 'rc-restart-registered-'))
  home = path.join(root, 'home')
  const bin = path.join(root, 'bin')
  pidLog = path.join(root, 'serve.pids')
  mkdirSync(home)
  mkdirSync(bin)
  mkdirSync(path.join(root, 'lib'))
  // State files and the plugin log go to a private HOME, never the real one.
  process.env.HOME = home
  // A fake `opencode serve` for the plugin path, which spawns one when lsof lists nothing.
  writeFileSync(
    path.join(root, 'lib', 'opencode'),
    `
const http = require('node:http')
const fs = require('node:fs')
if (process.argv[2] !== 'serve') process.exit(2)
fs.appendFileSync(${JSON.stringify(pidLog)}, process.pid + '\\n')
const server = http.createServer((req, res) => {
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/global/health') return send(200, { healthy: true })
  if (url.pathname === '/event') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': connected\\n\\n'); return }
  const m = /^\\/session\\/([^/]+)$/.exec(url.pathname)
  if (m) return send(200, { id: m[1], directory: process.cwd(), title: 'restart' })
  send(404, {})
})
server.listen(0, '127.0.0.1', () => console.log('opencode server listening on http://127.0.0.1:' + server.address().port))
process.on('SIGTERM', () => process.exit(0))
`,
  )
  writeFileSync(
    path.join(bin, 'opencode'),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(root, 'lib', 'opencode'))} "$@"\n`,
  )
  // Lists only what a test asks for, so a real opencode on this machine never decides a result.
  writeFileSync(path.join(bin, 'lsof'), '#!/bin/sh\n[ -n "$FAKE_LSOF_LINE" ] && echo "$FAKE_LSOF_LINE"\nexit 0\n')
  chmodSync(path.join(bin, 'opencode'), 0o755)
  chmodSync(path.join(bin, 'lsof'), 0o755)
  process.env.PATH = `${bin}${path.delimiter}${saved.PATH ?? ''}`
  process.env.REMOTE_CONTROL_START_TIMEOUT_MS = '20000'

  opencode = createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    if (req.headers.authorization !== opencodeAuthHeader()) return json(res, 401, { error: 'unauthorized' })
    if (url.pathname === '/global/health') return json(res, 200, { healthy: true })
    if (url.pathname === '/event') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(': connected\n\n')
      return
    }
    const m = /^\/session\/([^/]+)$/.exec(url.pathname)
    if (m) return json(res, 200, { id: decodeURIComponent(m[1]!), directory: root, title: 'restart' })
    json(res, 404, { error: 'not found' })
  })
  await new Promise<void>((resolve) => opencode.listen(0, '127.0.0.1', resolve))
  opencodePort = (opencode.address() as AddressInfo).port
  opencodeUrl = `http://127.0.0.1:${opencodePort}`
  relay = await startServer(0)
  relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`
  process.env.OPENCODE_REMOTE_CONTROL_RELAY = relayUrl
})

afterEach(async () => {
  const client = new RelayClient(relayUrl)
  for (const { id, token } of registrations.splice(0)) await client.deleteSession(id, token).catch(() => {})
})

afterAll(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  const servePids = existsSync(pidLog) ? readFileSync(pidLog, 'utf8').split('\n').filter(Boolean).map(Number) : []
  for (const pid of servePids) if (alive(pid)) process.kill(pid, 'SIGKILL')
  relay.closeAllConnections()
  await new Promise((resolve) => relay.close(resolve))
  opencode.closeAllConnections()
  await new Promise((resolve) => opencode.close(resolve))
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  rmSync(root, { recursive: true, force: true })
})

// POSIX only: whose process a pid is comes from `ps`.
test.skipIf(process.platform === 'win32')('a share whose bridge died is taken back: start registers the session again with a new code', async () => {
  const earlier = await register('ses_crashed')
  // The `opencode serve` the dead bridge spawned, re-parented and still running.
  const leftoverServer = lookalike('leftover', 'opencode', ['serve'])
  earlierState('ses_crashed', earlier, { pid: await exitedPid(), server_pid: leftoverServer.pid })
  // The server comes from detection (stood in for), as on the plugin path. A
  // start that names its server itself keeps the leftover: it may be that server.
  const serverSpawner = vi.fn(async () => ({ port: opencodePort }))

  const handle = await startBridge(relayUrl, API_KEY, { sessionId: 'ses_crashed', serverSpawner })
  try {
    expect(handle.access_code).toBeTruthy()
    expect(handle.access_code).not.toBe(earlier.access_code)
    const state = loadSessionState('ses_crashed')
    expect(state?.pid).toBe(process.pid)
    expect(state?.bridge_token).not.toBe(earlier.bridge_token)
    // The earlier registration is gone: its token no longer owns the session.
    expect(await new RelayClient(relayUrl).deleteSession('ses_crashed', earlier.bridge_token)).toBe(404)
    // So is the server that share left behind; the state holding its pid is overwritten.
    expect(await until(() => leftoverServer.exitCode !== null || leftoverServer.signalCode !== null, 5000)).toBe(true)
  } finally {
    await handle.stop()
  }
})

test.skipIf(process.platform === 'win32')('a share that is still running is left alone: start refuses before spawning anything and says how to end it', async () => {
  const earlier = await register('ses_live')
  const runningBridge = lookalike('running', 'remote-control-bridge.cjs', ['start'])
  const state = earlierState('ses_live', earlier, { pid: runningBridge.pid })
  const serverSpawner = vi.fn(async () => ({ port: opencodePort }))

  await expect(startBridge(relayUrl, API_KEY, { sessionId: 'ses_live', serverSpawner })).rejects.toThrow(
    new RegExp(`already shared from this machine \\(bridge pid ${runningBridge.pid}\\).*stop`),
  )
  expect(serverSpawner).not.toHaveBeenCalled()
  expect(loadSessionState('ses_live')).toEqual(state)
  expect(await relayStatus('ses_live')).toBe(200)
  expect(alive(runningBridge.pid)).toBe(true)
})

test('a session registered by a share this machine has no record of is explained, not a bare 409', async () => {
  await register('ses_foreign')
  await expect(startBridge(relayUrl, API_KEY, { opencodeUrl, sessionId: 'ses_foreign' })).rejects.toThrow(
    /already registered on the relay \(409\) by a share this machine has no record of/,
  )
  expect(await relayStatus('ses_foreign')).toBe(200)
})

test.skipIf(process.platform === 'win32')(
  'plugin: a second start of a live share fails with the reason and keeps the log holding its code',
  async () => {
    const earlier = await register('ses_plugin_live')
    const runningBridge = lookalike('running', 'remote-control-bridge.cjs', ['start'])
    earlierState('ses_plugin_live', earlier, { pid: runningBridge.pid })
    const log = logPath()
    writeFileSync(log, `${relayUrl}/ses_plugin_live\nCODE: ${earlier.access_code}\n`, { mode: 0o600 })

    await expect(runAction('start', 'ses_plugin_live')).rejects.toThrow(/already shared from this machine/)
    expect(readFileSync(log, 'utf8')).toBe(`${relayUrl}/ses_plugin_live\nCODE: ${earlier.access_code}\n`)
    expect(startLogs()).toEqual([])
    // The failed start's own output is kept apart, for troubleshooting.
    expect(readFileSync(failedLogPath(), 'utf8')).toContain('already shared from this machine')
  },
  30_000,
)

test.skipIf(process.platform === 'win32')(
  'plugin: a start after the bridge died (reboot, no server running) shares the session again',
  async () => {
    const earlier = await register('ses_rebooted')
    earlierState('ses_rebooted', earlier, { pid: await exitedPid() })

    const out: string = await runAction('start', 'ses_rebooted')
    expect(out).toMatch(new RegExp(`^${relayUrl}/ses_rebooted\\nCODE: \\S+$`))
    expect(out).not.toContain(earlier.access_code)
    // The start that came up is what bridge.log holds now.
    expect(readFileSync(logPath(), 'utf8')).toContain(out.split('\n')[1])
    expect(startLogs()).toEqual([])
    const bridgePid = loadSessionState('ses_rebooted')?.pid
    expect(bridgePid).toBeGreaterThan(0)
    try {
      expect(
        await until(async () => (await new RelayClient(relayUrl).getSession('ses_rebooted')).body?.bridge_connected === true, 5000),
      ).toBe(true)
    } finally {
      await runAction('stop', 'ses_rebooted')
      expect(await until(() => !alive(bridgePid), 5000)).toBe(true)
    }
  },
  30_000,
)

test.skipIf(process.platform === 'win32')(
  'status: a share whose bridge is gone is named stale and exits non-zero',
  async () => {
    const earlier = await register('ses_stale')
    earlierState('ses_stale', earlier, { pid: await exitedPid() })

    const { code, stdout } = await runCli(['status', '--relay', relayUrl, '--session-id', 'ses_stale'], {
      // opencode is detected, the relay is up and holds the session: only the bridge is missing.
      FAKE_LSOF_LINE: `node ${process.pid} user 20u IPv4 0x0 0t0 TCP 127.0.0.1:${opencodePort} (LISTEN)`,
    })
    expect(stdout).toContain(`opencode: detected on port ${opencodePort}`)
    expect(stdout).toContain('session ses_stale: active')
    expect(stdout).toMatch(/bridge process: not running/)
    expect(code).toBe(1)
  },
  30_000,
)
