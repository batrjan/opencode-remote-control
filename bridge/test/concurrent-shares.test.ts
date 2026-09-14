import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { AddressInfo } from 'node:net'
import { startServer } from '../../relay/src/server'
import { opencodeAuthHeader } from '../src/config'
import { ensureOpenCodeServer } from '../src/detect'
import { belongsToRunningShare, type ProcessParent } from '../src/index'

/**
 * A second share must not run on the `opencode serve` the first share spawned.
 *
 * The TUI has no HTTP port, so a share started from it spawns its own
 * `opencode serve`, and that server's lifetime belongs to the share: every way
 * the share ends (`stop`, the relay revoking it, a signal, the bridge exiting)
 * kills it. Detection could not tell such a server from one the user runs
 * themselves — it takes the first healthy node/opencode listener — so a second
 * share started while the first was live (another TUI, another project)
 * attached to the first share's server, recorded no server of its own, and
 * spawned nothing. Ending the first share then killed the server under the
 * second: its viewers got 502 "opencode unreachable", and a few watchdog ticks
 * later the second bridge ended its share too (relay session gone, viewer
 * tokens 401), with nothing but its private log to say so — and anything
 * running in that server for the second session died with it. Reproduced with
 * the committed bundle through `stop`, a relay revocation and a SIGHUP.
 *
 * Detection now skips a server spawned by a bridge that is still running, so
 * the second share spawns its own. A server the user started is still used.
 *
 * Driven through the committed bundle, the way the plugin runs it. Stand-ins:
 * a fake `opencode serve` on PATH, and `lsof` restricted to this test's own
 * processes, so a real opencode on the machine can never decide the result.
 * POSIX only (shell-script fakes, lsof).
 */

const BUNDLE = fileURLToPath(new URL('../../plugin/bridge/remote-control-bridge.cjs', import.meta.url))
const PASSWORD = 'concurrent-shares-test'
const execFileP = promisify(execFile)

/** The machine's real lsof, found before the fake one goes on PATH. */
const REAL_LSOF = [...(process.env.PATH ?? '').split(path.delimiter), '/usr/sbin', '/usr/bin']
  .filter(Boolean)
  .map((dir) => path.join(dir, 'lsof'))
  .find((file) => existsSync(file))

let relay: Server
let relayUrl: string
let root: string
let home: string
let spawnLog: string
let env: NodeJS.ProcessEnv
const children: ChildProcess[] = []

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
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return check()
}

interface Proc {
  child: ChildProcess
  output: () => string
  exited: Promise<number | null>
}

function run(args: string[]): Proc {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  let output = ''
  child.stdout!.on('data', (chunk) => (output += chunk))
  child.stderr!.on('data', (chunk) => (output += chunk))
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)))
  return { child, output: () => output, exited }
}

/** A running share started the way the plugin starts one; resolves once its code is printed. */
async function startShare(sessionId: string): Promise<Proc & { code: string }> {
  const proc = run([BUNDLE, 'start', '--relay', relayUrl, '--session-id', sessionId])
  const ready = await until(() => /CODE: \S+/.test(proc.output()) || proc.child.exitCode !== null, 20_000)
  const code = /CODE: (\S+)/.exec(proc.output())?.[1]
  if (!ready || !code) throw new Error(`share ${sessionId} did not start:\n${proc.output()}`)
  return { ...proc, code }
}

function state(sessionId: string): { pid?: number; server_pid?: number } | undefined {
  const file = path.join(home, '.agents', 'skills', 'remote-control', 'state', `${sessionId}.json`)
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined
}

/** Every fake `opencode serve` started so far: [pid, port]. */
function spawned(): number[][] {
  if (!existsSync(spawnLog)) return []
  return readFileSync(spawnLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(' ').map(Number))
}

async function activate(sessionId: string, code: string): Promise<string> {
  const res = await fetch(`${relayUrl}/api/activate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, session_id: sessionId }),
  })
  expect(res.status).toBe(200)
  await res.arrayBuffer()
  // The relay sends the token only as the HttpOnly viewer cookie; the body is
  // just { session_id }.
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('viewer_token='))
  expect(cookie).toBeTruthy()
  return decodeURIComponent(cookie!.slice('viewer_token='.length).split(';')[0]!)
}

async function viewerGet(sessionId: string, token: string): Promise<number> {
  const res = await fetch(`${relayUrl}/session/${sessionId}/message`, { headers: { 'x-viewer-token': token } })
  await res.arrayBuffer()
  return res.status
}

async function relaySession(sessionId: string): Promise<number> {
  const res = await fetch(`${relayUrl}/api/sessions/${sessionId}`)
  await res.arrayBuffer()
  return res.status
}

/** `bridge stop` as the plugin runs it. Async: the relay it talks to lives in this process. */
async function stopShare(sessionId: string): Promise<string> {
  const { stdout } = await execFileP(process.execPath, [BUNDLE, 'stop', '--relay', relayUrl, '--session-id', sessionId], {
    cwd: root,
    env,
    timeout: 15_000,
  })
  return stdout
}

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'rc-concurrent-shares-'))
  home = path.join(root, 'home')
  const bin = path.join(root, 'bin')
  const lib = path.join(root, 'lib')
  spawnLog = path.join(root, 'spawned.txt')
  mkdirSync(home)
  mkdirSync(bin)
  mkdirSync(lib)
  // Named `opencode` so its command line reads `... opencode serve`, like the
  // real server's — what `stop` checks before signalling a recorded server_pid.
  writeFileSync(
    path.join(lib, 'opencode'),
    `
const http = require('node:http')
const fs = require('node:fs')
const args = process.argv.slice(2)
if (args[0] !== 'serve') process.exit(2)
const expected = 'Basic ' + Buffer.from('opencode:' + ${JSON.stringify(PASSWORD)}).toString('base64')
const sessions = ['ses_conc_a', 'ses_conc_b', 'ses_conc_user'].map((id) => ({ id, directory: ${JSON.stringify(root)}, title: id }))
const server = http.createServer((req, res) => {
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  if (req.headers.authorization !== expected) return send(401, { error: 'unauthorized' })
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/global/health') return send(200, { healthy: true })
  if (url.pathname === '/event') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': connected\\n\\n'); return }
  if (url.pathname === '/session') return send(200, sessions)
  let m = /^\\/session\\/([^/]+)$/.exec(url.pathname)
  if (m) { const s = sessions.find((x) => x.id === m[1]); return s ? send(200, s) : send(404, {}) }
  m = /^\\/session\\/([^/]+)\\/message$/.exec(url.pathname)
  if (m) return send(200, [])
  send(404, { error: 'not found' })
})
server.listen(0, '127.0.0.1', () => {
  fs.appendFileSync(${JSON.stringify(spawnLog)}, process.pid + ' ' + server.address().port + '\\n')
  console.log('opencode server listening on http://127.0.0.1:' + server.address().port)
})
process.on('SIGTERM', () => process.exit(0))
`,
  )
  // The real lsof, passing through only this test's processes.
  writeFileSync(
    path.join(lib, 'lsof.cjs'),
    `
const { execFileSync } = require('node:child_process')
let out = ''
try { out = execFileSync(${JSON.stringify(REAL_LSOF ?? 'lsof')}, process.argv.slice(2), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) }
catch (err) { out = err.stdout || '' }
for (const line of out.split('\\n')) {
  const pid = line.trim().split(/\\s+/)[1]
  if (!/^\\d+$/.test(pid || '')) continue
  let command = ''
  try { command = execFileSync('ps', ['-p', pid, '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) } catch {}
  if (command.includes(${JSON.stringify(root)})) console.log(line)
}
`,
  )
  writeFileSync(
    path.join(bin, 'opencode'),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(lib, 'opencode'))} "$@"\n`,
  )
  writeFileSync(
    path.join(bin, 'lsof'),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(lib, 'lsof.cjs'))} "$@"\n`,
  )
  chmodSync(path.join(bin, 'opencode'), 0o755)
  chmodSync(path.join(bin, 'lsof'), 0o755)
  env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
    OPENCODE_SERVER_USERNAME: 'opencode',
    OPENCODE_SERVER_PASSWORD: PASSWORD,
    REMOTE_CONTROL_WATCHDOG_INTERVAL_MS: '100',
  }
  relay = await startServer(0)
  relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`
})

// A failed test must not leave a server behind for the next one to find.
afterEach(async () => {
  vi.restoreAllMocks()
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  for (const [pid] of spawned()) if (alive(pid)) process.kill(pid!, 'SIGKILL')
  await until(() => spawned().every(([pid]) => !alive(pid)), 5000)
})

afterAll(async () => {
  relay.closeAllConnections()
  await new Promise((resolve) => relay.close(resolve))
  rmSync(root, { recursive: true, force: true })
})

test.skipIf(process.platform === 'win32' || !REAL_LSOF)(
  'ending one share leaves a share started next to it running, on a server of its own',
  async () => {
    const a = await startShare('ses_conc_a')
    const stateA = state('ses_conc_a')
    // Nothing was listening, so share A spawned the server (otherwise this proves nothing).
    expect(stateA?.server_pid).toBeGreaterThan(0)
    expect(alive(stateA?.server_pid)).toBe(true)

    const b = await startShare('ses_conc_b')
    const stateB = state('ses_conc_b')
    const viewerToken = await activate('ses_conc_b', b.code)
    expect(await viewerGet('ses_conc_b', viewerToken)).toBe(200)
    const serversAfterB = spawned().length

    // End share A only.
    expect(await stopShare('ses_conc_a')).toContain('Remote control stopped.')
    expect(await until(() => !alive(stateA?.pid) && !alive(stateA?.server_pid), 10_000)).toBe(true)
    // Many watchdog ticks: long past the few failed probes that end a share.
    const bExited = await Promise.race([
      b.exited.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 2000)),
    ])

    expect({
      bridgeBRunning: !bExited,
      relaySessionB: await relaySession('ses_conc_b'),
      viewerB: await viewerGet('ses_conc_b', viewerToken),
    }).toEqual({ bridgeBRunning: true, relaySessionB: 200, viewerB: 200 })
    // Why: share B runs on a server it spawned and owns, not on share A's.
    expect(serversAfterB).toBe(2)
    expect(stateB?.server_pid).toBeGreaterThan(0)
    expect(stateB?.server_pid).not.toBe(stateA?.server_pid)
    expect(alive(stateB?.server_pid)).toBe(true)

    expect(await stopShare('ses_conc_b')).toContain('Remote control stopped.')
    // `stop` both tells the relay (which closes the bridge) and signals the
    // bridge, so a bridge may end either way; either way it is gone.
    const ended = (p: Proc) => p.child.exitCode !== null || p.child.signalCode !== null
    expect(await until(() => ended(a) && ended(b), 10_000)).toBe(true)
    expect(await until(() => !alive(stateB?.server_pid), 10_000)).toBe(true)
  },
  60_000,
)

test.skipIf(process.platform === 'win32' || !REAL_LSOF)(
  'a server the owner started themselves is still used, and outlives the share',
  async () => {
    // Started by the owner (this process), not by a bridge.
    const user = run([path.join(root, 'lib', 'opencode'), 'serve'])
    expect(await until(() => /listening on http/.test(user.output()), 10_000)).toBe(true)
    const before = spawned().length

    await startShare('ses_conc_user')
    expect(state('ses_conc_user')?.server_pid).toBeUndefined()
    expect(spawned().length).toBe(before)

    expect(await stopShare('ses_conc_user')).toContain('Remote control stopped.')
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(user.child.exitCode).toBeNull()
    expect(user.child.signalCode).toBeNull()
  },
  60_000,
)

/* The two halves of the decision, in process: which server is a share's, and what detection does with one. */

/** A command line as `ps` reports it for a bridge the plugin started. */
const BRIDGE_COMMAND = `${process.execPath} /Users/me/.opencode/plugin/bridge/remote-control-bridge.cjs start --relay https://r`

/** A fake process table for belongsToRunningShare: pid -> parent + command line. */
function table(entries: Record<number, ProcessParent>): (pid: number) => ProcessParent | null {
  return (pid) => entries[pid] ?? null
}

test('a server whose parent (or a wrapper\'s parent) is a running bridge belongs to a share; a user-run one does not', () => {
  // `opencode serve` spawned by a bridge.
  expect(
    belongsToRunningShare(
      300,
      table({ 300: { ppid: 200, command: 'opencode serve --hostname 127.0.0.1' }, 200: { ppid: 1, command: BRIDGE_COMMAND } }),
    ),
  ).toBe(true)
  // `opencode` on PATH was a wrapper that started the real binary.
  expect(
    belongsToRunningShare(
      301,
      table({
        301: { ppid: 250, command: '/opt/opencode/bin/opencode-real serve --hostname 127.0.0.1' },
        250: { ppid: 200, command: `${process.execPath} /opt/opencode/bin/opencode serve --hostname 127.0.0.1` },
        200: { ppid: 1, command: BRIDGE_COMMAND },
      }),
    ),
  ).toBe(true)
  // Started by the owner from a terminal.
  expect(
    belongsToRunningShare(
      302,
      table({
        302: { ppid: 120, command: 'opencode serve' },
        120: { ppid: 110, command: '-zsh' },
        110: { ppid: 1, command: '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal' },
      }),
    ),
  ).toBe(false)
  // Left behind by a bridge killed with -9: re-parented to init, nobody's any more.
  expect(belongsToRunningShare(303, table({ 303: { ppid: 1, command: 'opencode serve --hostname 127.0.0.1' } }))).toBe(false)
  // The desktop app's own server.
  expect(
    belongsToRunningShare(
      304,
      table({ 304: { ppid: 90, command: 'opencode serve --port 4096' }, 90: { ppid: 1, command: '/Applications/OpenCode.app/Contents/MacOS/OpenCode' } }),
    ),
  ).toBe(false)
  // No `ps`: nothing is claimed, and nothing throws.
  expect(
    belongsToRunningShare(305, () => {
      throw new Error('ps unavailable')
    }),
  ).toBe(false)
})

test.skipIf(process.platform === 'win32')('a server this very process spawned belongs to a share, read with the real ps', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  children.push(child)
  try {
    // No injection: the parent link as this OS's `ps` reports it.
    expect(await until(() => belongsToRunningShare(child.pid!), 2000)).toBe(true)
  } finally {
    child.kill('SIGKILL')
  }
})

test('detection skips a healthy server that belongs to a share and attaches to the user\'s', async () => {
  process.env.OPENCODE_SERVER_USERNAME = 'opencode'
  process.env.OPENCODE_SERVER_PASSWORD = PASSWORD
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const healthy = () =>
    createServer((req, res) => {
      const ok = req.url === '/global/health' && req.headers.authorization === opencodeAuthHeader()
      res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(ok ? { healthy: true } : { error: 'unauthorized' }))
    })
  const shareServer = healthy()
  const userServer = healthy()
  await new Promise<void>((resolve) => shareServer.listen(0, '127.0.0.1', resolve))
  await new Promise<void>((resolve) => userServer.listen(0, '127.0.0.1', resolve))
  const sharePort = (shareServer.address() as AddressInfo).port
  const userPort = (userServer.address() as AddressInfo).port
  try {
    const asked: number[] = []
    const ensured = await ensureOpenCodeServer({
      // The share's server is listed first, as the lower port on a real machine usually is.
      listListeners: async () => [
        { port: sharePort, pid: 111 },
        { port: userPort, pid: 222 },
      ],
      ownedByShare: (pid) => {
        asked.push(pid)
        return pid === 111
      },
    })
    expect(ensured.port).toBe(userPort)
    expect(ensured.spawned).toBeUndefined()
    expect(asked).toEqual([111, 222])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`not attaching to the opencode server on port ${sharePort}`))
  } finally {
    await new Promise((resolve) => shareServer.close(resolve))
    await new Promise((resolve) => userServer.close(resolve))
  }
})
