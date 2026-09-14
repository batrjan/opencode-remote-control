import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { startServer } from '../../relay/src/server'
import { spawnedByRecordedShare, startBridge, stopBridge } from '../src/index'
import { RelayClient } from '../src/relay'
import { loadSessionState, saveSessionState } from '../src/state'

/**
 * A start that picks its session itself must not run on the `opencode serve`
 * a dead share left behind.
 *
 * When a bridge is killed with -9 (or crashes), the server it spawned is
 * re-parented to init and keeps listening; only the dead share's state file
 * still names it (`server_pid`). A start with an explicit session id settles
 * that share before detection, so the leftover is gone by the time detection
 * looks. A start without one — the plugin outside a session route, e.g. the
 * TUI's home screen — only learns its session after detection, and detection
 * took the leftover for the owner's own server: the ancestry check no longer
 * ties it to any bridge. The new share attached to it and recorded no
 * `server_pid`; taking back the dead share then dropped the only state naming
 * the server and left it running (an attached server may be the one this start
 * runs on, so it was not ended), and nothing ever ended it. When the start
 * picked a different session, the dead share's state kept naming the server
 * the new share ran on, and a `stop` of that stale share killed it under the
 * live one.
 *
 * Driven in process through the default detection. Stand-ins: an in-process
 * relay, a fake `opencode serve` on PATH, a leftover server re-parented away
 * from this process, and an `lsof` that lists only what a test asks for, so no
 * real server on this machine decides a result. POSIX only.
 */

const API_KEY = 'test-relay-key'
process.env.RELAY_API_KEY = API_KEY

let relay: Server
let relayUrl: string
let root: string
let spawnLog: string
let sessionsFile: string
const saved: Record<string, string | undefined> = {}
const ENV_KEYS = ['HOME', 'PATH', 'FAKE_LSOF_LINES'] as const
const servers: Server[] = []
/** Registrations made by the tests themselves, removed after each test. */
const registrations: { id: string; token: string }[] = []

function alive(pid: number | undefined): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return check()
}

/** The sessions every stand-in server lists, newest first. */
function listSessions(ids: string[]) {
  writeFileSync(sessionsFile, JSON.stringify(ids.map((id, i) => ({ id, directory: root, title: id, time: { created: 1000 - i } }))))
}

/** Every fake `opencode serve` started so far, by pid: its port. */
function spawned(): Map<number, number> {
  if (!existsSync(spawnLog)) return new Map()
  return new Map(
    readFileSync(spawnLog, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(' ').map(Number) as [number, number]),
  )
}

/**
 * An `opencode serve` whose bridge is gone: started through a shell that exits
 * at once, so it is re-parented to init exactly like the server of a bridge
 * killed with -9.
 */
async function leftoverServer(): Promise<{ pid: number; port: number }> {
  const shell = spawn(
    '/bin/sh',
    ['-c', `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(root, 'lib', 'opencode'))} serve --hostname 127.0.0.1 >/dev/null 2>&1 & echo $!`],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  )
  let out = ''
  shell.stdout!.on('data', (chunk) => (out += chunk))
  await new Promise((resolve) => shell.once('close', resolve))
  const pid = Number(out.trim())
  expect(await until(() => spawned().has(pid), 10_000)).toBe(true)
  return { pid, port: spawned().get(pid)! }
}

/** The pid of a process that has already exited: what a state file names after its bridge was killed. */
async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await new Promise((resolve) => child.once('exit', resolve))
  return child.pid!
}

/** A share of `id` whose bridge was killed, leaving the server `serverPid` behind. */
async function deadShare(id: string, serverPid: number) {
  const session = await new RelayClient(relayUrl, API_KEY).createSession(id, root, 'earlier share')
  registrations.push({ id, token: session.bridge_token })
  saveSessionState({
    session_id: id,
    access_code: session.access_code,
    bridge_token: session.bridge_token,
    relay: relayUrl,
    started_at: Date.now(),
    pid: await exitedPid(),
    server_pid: serverPid,
  })
  return session
}

/** A listener line as `lsof -iTCP -sTCP:LISTEN -P` prints it. */
function lsofLine(pid: number, port: number): string {
  return `node ${pid} user 20u IPv4 0x0 0t0 TCP 127.0.0.1:${port} (LISTEN)`
}

beforeAll(async () => {
  for (const key of ENV_KEYS) saved[key] = process.env[key]
  root = mkdtempSync(path.join(tmpdir(), 'rc-leftover-picked-'))
  const home = path.join(root, 'home')
  const bin = path.join(root, 'bin')
  const lib = path.join(root, 'lib')
  spawnLog = path.join(root, 'spawned.txt')
  sessionsFile = path.join(root, 'sessions.json')
  mkdirSync(home)
  mkdirSync(bin)
  mkdirSync(lib)
  // State files go to a private HOME, never the real one.
  process.env.HOME = home
  // Named `opencode` so its command line reads `... opencode serve`, like the real server's.
  writeFileSync(
    path.join(lib, 'opencode'),
    `
const http = require('node:http')
const fs = require('node:fs')
if (process.argv[2] !== 'serve') process.exit(2)
const server = http.createServer((req, res) => {
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  const url = new URL(req.url, 'http://x')
  const sessions = JSON.parse(fs.readFileSync(${JSON.stringify(sessionsFile)}, 'utf8'))
  if (url.pathname === '/global/health') return send(200, { healthy: true })
  if (url.pathname === '/event') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': connected\\n\\n'); return }
  if (url.pathname === '/session') return send(200, sessions)
  const m = /^\\/session\\/([^/]+)$/.exec(url.pathname)
  if (m) { const s = sessions.find((x) => x.id === m[1]); return s ? send(200, s) : send(404, {}) }
  send(404, {})
})
server.listen(0, '127.0.0.1', () => {
  fs.appendFileSync(${JSON.stringify(spawnLog)}, process.pid + ' ' + server.address().port + '\\n')
  console.log('opencode server listening on http://127.0.0.1:' + server.address().port)
})
process.on('SIGTERM', () => process.exit(0))
`,
  )
  writeFileSync(
    path.join(bin, 'opencode'),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(lib, 'opencode'))} "$@"\n`,
  )
  writeFileSync(path.join(bin, 'lsof'), '#!/bin/sh\n[ -n "$FAKE_LSOF_LINES" ] && printf \'%s\\n\' "$FAKE_LSOF_LINES"\nexit 0\n')
  chmodSync(path.join(bin, 'opencode'), 0o755)
  chmodSync(path.join(bin, 'lsof'), 0o755)
  process.env.PATH = `${bin}${path.delimiter}${saved.PATH ?? ''}`
  relay = await startServer(0)
  relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`
})

afterEach(async () => {
  vi.restoreAllMocks()
  delete process.env.FAKE_LSOF_LINES
  const client = new RelayClient(relayUrl)
  for (const { id, token } of registrations.splice(0)) await client.deleteSession(id, token).catch(() => {})
  for (const pid of spawned().keys()) if (alive(pid)) process.kill(pid, 'SIGKILL')
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

afterAll(async () => {
  for (const pid of spawned().keys()) if (alive(pid)) process.kill(pid, 'SIGKILL')
  relay.closeAllConnections()
  await new Promise((resolve) => relay.close(resolve))
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  rmSync(root, { recursive: true, force: true })
})

test.skipIf(process.platform === 'win32')(
  'a start without a session id takes back a dead share on a server of its own, and ends the server that share left behind',
  async () => {
    listSessions(['ses_home_restart'])
    const leftover = await leftoverServer()
    const earlier = await deadShare('ses_home_restart', leftover.pid)
    process.env.FAKE_LSOF_LINES = lsofLine(leftover.pid, leftover.port)

    const handle = await startBridge(relayUrl, API_KEY)
    let serverPid: number | undefined
    try {
      expect(handle.session_id).toBe('ses_home_restart')
      const state = loadSessionState('ses_home_restart')
      expect(state?.bridge_token).not.toBe(earlier.bridge_token)
      serverPid = state?.server_pid
      expect({
        runsOnServerOfItsOwn: typeof serverPid === 'number' && serverPid !== leftover.pid && alive(serverPid),
        leftoverEnded: await until(() => !alive(leftover.pid), 5000),
      }).toEqual({ runsOnServerOfItsOwn: true, leftoverEnded: true })
    } finally {
      await handle.stop()
    }
    expect(await until(() => !alive(serverPid), 5000)).toBe(true)
  },
  30_000,
)

test.skipIf(process.platform === 'win32')(
  'a start without a session id that picks another session does not run on a dead share\'s server, so stopping that share leaves it up',
  async () => {
    listSessions(['ses_picked_newest'])
    const leftover = await leftoverServer()
    await deadShare('ses_dead_other', leftover.pid)
    process.env.FAKE_LSOF_LINES = lsofLine(leftover.pid, leftover.port)

    const handle = await startBridge(relayUrl, API_KEY)
    try {
      expect(handle.session_id).toBe('ses_picked_newest')
      const serverPid = loadSessionState('ses_picked_newest')?.server_pid
      expect(typeof serverPid === 'number' && serverPid !== leftover.pid).toBe(true)
      // The dead share still names the server it left, so its own `stop` ends it...
      expect(loadSessionState('ses_dead_other')?.server_pid).toBe(leftover.pid)
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      expect(await stopBridge(relayUrl, 'ses_dead_other', API_KEY)).toBeUndefined()
      expect(await until(() => !alive(leftover.pid), 5000)).toBe(true)
      // ...and the share that is running keeps its server.
      expect(alive(serverPid)).toBe(true)
    } finally {
      await handle.stop()
    }
  },
  30_000,
)

test.skipIf(process.platform === 'win32')(
  'the owner\'s own server is still used, and the server a dead share left next to it is ended when that share is taken back',
  async () => {
    listSessions(['ses_owner_server'])
    // The owner's own server, run by this process: no bridge among its ancestors, no state names it.
    const owner = createServer((req, res) => {
      const url = new URL(req.url ?? '', 'http://x')
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      const sessions = JSON.parse(readFileSync(sessionsFile, 'utf8')) as { id: string }[]
      if (url.pathname === '/global/health') return send(200, { healthy: true })
      if (url.pathname === '/event') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(': connected\n\n')
        return
      }
      if (url.pathname === '/session') return send(200, sessions)
      const m = /^\/session\/([^/]+)$/.exec(url.pathname)
      const s = m && sessions.find((x) => x.id === m[1])
      return s ? send(200, s) : send(404, {})
    })
    servers.push(owner)
    await new Promise<void>((resolve) => owner.listen(0, '127.0.0.1', resolve))
    const ownerPort = (owner.address() as AddressInfo).port
    const leftover = await leftoverServer()
    await deadShare('ses_owner_server', leftover.pid)
    // The owner's server is listed first, so detection attaches to it either way.
    process.env.FAKE_LSOF_LINES = `${lsofLine(process.pid, ownerPort)}\n${lsofLine(leftover.pid, leftover.port)}`
    const serversBefore = spawned().size

    const handle = await startBridge(relayUrl, API_KEY)
    try {
      expect(handle.session_id).toBe('ses_owner_server')
      // Attached, not spawned: the owner's server is never recorded as the share's.
      expect(loadSessionState('ses_owner_server')?.server_pid).toBeUndefined()
      expect(spawned().size).toBe(serversBefore)
      expect(await until(() => !alive(leftover.pid), 5000)).toBe(true)
    } finally {
      await handle.stop()
    }
  },
  30_000,
)

/* Which listener detection treats as a recorded share's server, in process with a fake process table. */

test('a listener is a recorded share\'s server when it, or a wrapper above it, is the server_pid a share recorded and still that server', () => {
  const startedAt = Date.parse('2026-09-14T10:00:00Z')
  const states = [
    { session_id: 'ses_a', access_code: 'A', bridge_token: 't', relay: 'http://r', started_at: startedAt, pid: 10, server_pid: 500 },
    // Attached to the owner's server: nothing recorded, nothing claimed.
    { session_id: 'ses_b', access_code: 'B', bridge_token: 't', relay: 'http://r', started_at: startedAt, pid: 11 },
  ]
  const serve = { command: 'opencode serve --hostname 127.0.0.1', startedAt: startedAt - 2000 }
  const processes = (table: Record<number, { command: string; startedAt?: number }>) => (pid: number) => table[pid] ?? null
  const parents = (table: Record<number, number>) => (pid: number) =>
    table[pid] === undefined ? null : { ppid: table[pid]!, command: 'x' }

  // The recorded server itself, re-parented to init after its bridge was killed.
  expect(spawnedByRecordedShare(500, states, processes({ 500: serve }), parents({ 500: 1 }))).toBe(true)
  // The real binary under a recorded `opencode` wrapper.
  expect(
    spawnedByRecordedShare(
      501,
      states,
      processes({ 500: { command: `${process.execPath} /usr/local/bin/opencode serve --hostname 127.0.0.1`, startedAt: serve.startedAt }, 501: serve }),
      parents({ 501: 500, 500: 1 }),
    ),
  ).toBe(true)
  // The owner's own server, run from a terminal.
  expect(spawnedByRecordedShare(502, states, processes({ 502: serve }), parents({ 502: 120, 120: 1 }))).toBe(false)
  // The recorded pid recycled into a server the owner started later.
  expect(
    spawnedByRecordedShare(500, states, processes({ 500: { ...serve, startedAt: startedAt + 3_600_000 } }), parents({ 500: 1 })),
  ).toBe(false)
  // The recorded pid recycled into something that is no server at all, above the listener.
  expect(
    spawnedByRecordedShare(503, states, processes({ 500: { command: '-zsh', startedAt: serve.startedAt } }), parents({ 503: 500, 500: 1 })),
  ).toBe(false)
  // No `ps`: nothing is claimed, and nothing throws.
  const noPs = () => {
    throw new Error('ps unavailable')
  }
  expect(spawnedByRecordedShare(500, states, noPs, noPs)).toBe(false)
  // No share recorded a server: `ps` is not even asked.
  const inspect = vi.fn(noPs)
  expect(spawnedByRecordedShare(500, [states[1]!], inspect, inspect)).toBe(false)
  expect(inspect).not.toHaveBeenCalled()
})
