import { afterAll, beforeAll, expect, test } from 'vitest'
import { createServer, type Server } from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import { startServer } from '../../relay/src/server'
import { opencodeAuthHeader } from '../src/config'
import { startBridge } from '../src/index'
import { RelayClient } from '../src/relay'
import { loadSessionState } from '../src/state'

/**
 * A `start` that fails after it spawned `opencode serve` must take that server
 * down with it.
 *
 * On the TUI path there is no HTTP port to find, so the bridge spawns its own
 * server — and only armed the cleanup for it once the share was fully up.
 * Everything in between could throw with the server left running: the relay
 * unreachable, a 429 (registrations are rate-limited per IP), a 409 for a
 * session id a stale share still holds, no session to pick, the bridge
 * WebSocket refused. Worse than the orphan itself, the child's stdout/stderr
 * pipes kept the failed CLI's event loop alive, so the detached bridge hung
 * next to its server with no state file for `stop` to find. The next `start`
 * then detected that leftover server and attached to it without recording a
 * `server_pid`, so no later `stop` ever killed it either.
 */

const API_KEY = 'test-relay-key'
process.env.RELAY_API_KEY = API_KEY

let relay: Server
let relayUrl: string
let opencode: Server
let opencodePort: number
let home: string
const savedHome = process.env.HOME
const children: ChildProcess[] = []

function json(res: import('node:http').ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

/**
 * A stand-in for the `opencode serve` ensureOpenCodeServer() hands back — with
 * the same stdio: piped, with data listeners attached. Those pipes are what
 * kept a failed CLI from ever exiting.
 */
function spawnServerLikeChild(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout!.on('data', () => {})
  child.stderr!.on('data', () => {})
  children.push(child)
  return child
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

async function waitForExit(child: ChildProcess, timeoutMs = 3000): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true
  return await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

async function until(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return check()
}

/** A local URL nothing listens on: a port that was just bound and released. */
async function closedUrl(): Promise<string> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  await new Promise((resolve) => server.close(resolve))
  return url
}

/** A relay that accepts the registration and then refuses the bridge WebSocket. */
async function relayRefusingBridge(): Promise<{ url: string; deletes: string[]; close: () => Promise<void> }> {
  const deletes: string[] = []
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/sessions') {
      return json(res, 201, { access_code: 'ZZZZZZ', bridge_token: 'token-never-used', viewer_url: '/s/x' })
    }
    if (req.method === 'DELETE') deletes.push(req.url ?? '')
    res.writeHead(204)
    res.end()
  })
  server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n'))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    deletes,
    close: async () => {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

beforeAll(async () => {
  // State files go to a private HOME, never the real one.
  home = mkdtempSync(path.join(tmpdir(), 'rc-start-failure-'))
  process.env.HOME = home
  opencode = createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    if (req.headers.authorization !== opencodeAuthHeader()) return json(res, 401, { error: 'unauthorized' })
    if (url.pathname === '/global/health') return json(res, 200, { healthy: true })
    // No sessions at all: what pickSession() finds in a project never opened.
    if (url.pathname === '/session') return json(res, 200, [])
    json(res, 404, { error: 'not found' })
  })
  await new Promise<void>((resolve) => opencode.listen(0, '127.0.0.1', resolve))
  opencodePort = (opencode.address() as AddressInfo).port
  relay = await startServer(0)
  relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`
})

afterAll(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  relay.closeAllConnections()
  await new Promise((resolve) => relay.close(resolve))
  opencode.closeAllConnections()
  await new Promise((resolve) => opencode.close(resolve))
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  rmSync(home, { recursive: true, force: true })
})

test('a relay that cannot be reached kills the opencode server start spawned', async () => {
  const server = spawnServerLikeChild()
  const exitListeners = process.listenerCount('exit')
  await expect(
    startBridge(await closedUrl(), API_KEY, {
      sessionId: 'ses_fail_unreachable',
      serverSpawner: async () => ({ port: opencodePort, spawned: server }),
    }),
  ).rejects.toThrow()
  expect(await waitForExit(server)).toBe(true)
  // A failed start in a long-lived process (the tests, a library caller) must
  // not leave its exit hook behind either.
  expect(process.listenerCount('exit')).toBe(exitListeners)
})

test('a relay that refuses the registration (409, a stale share holds the id) kills the spawned server', async () => {
  await new RelayClient(relayUrl, API_KEY).createSession('ses_fail_409', '/path', 'stale share')
  const server = spawnServerLikeChild()
  await expect(
    startBridge(relayUrl, API_KEY, {
      sessionId: 'ses_fail_409',
      serverSpawner: async () => ({ port: opencodePort, spawned: server }),
    }),
  ).rejects.toThrow(/409/)
  expect(await waitForExit(server)).toBe(true)
})

test('no session to share kills the spawned server', async () => {
  const server = spawnServerLikeChild()
  await expect(
    startBridge(relayUrl, API_KEY, { serverSpawner: async () => ({ port: opencodePort, spawned: server }) }),
  ).rejects.toThrow(/no opencode sessions found/)
  expect(await waitForExit(server)).toBe(true)
})

test('a refused bridge WebSocket kills the spawned server and still removes the registration', async () => {
  const refusing = await relayRefusingBridge()
  const server = spawnServerLikeChild()
  try {
    await expect(
      startBridge(refusing.url, API_KEY, {
        sessionId: 'ses_fail_ws',
        serverSpawner: async () => ({ port: opencodePort, spawned: server }),
      }),
    ).rejects.toThrow(/HTTP 404/)
    expect(await waitForExit(server)).toBe(true)
    expect(refusing.deletes).toEqual(['/api/sessions/ses_fail_ws'])
    expect(loadSessionState('ses_fail_ws')).toBeUndefined()
  } finally {
    await refusing.close()
  }
})

/**
 * The same failure the way the plugin hits it: the committed bundle, no
 * opencode listening (a fake `lsof` reports nothing), so it spawns a fake
 * `opencode serve` — and the relay is down. The CLI has to report the failure
 * and exit rather than hang on its server. POSIX only: the fakes are shell
 * scripts on PATH.
 */
test.skipIf(process.platform === 'win32')(
  'CLI: a failed start exits and leaves no opencode serve behind',
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'rc-start-failure-cli-'))
    const cliHome = path.join(root, 'home')
    const bin = path.join(root, 'bin')
    const pidFile = path.join(root, 'server.pid')
    mkdirSync(cliHome)
    mkdirSync(bin)
    const password = 'start-failure-test'
    writeFileSync(
      path.join(root, 'fake-opencode.cjs'),
      `
const http = require('node:http')
const fs = require('node:fs')
if (process.argv[2] !== 'serve') process.exit(2)
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
// Like the real \`opencode serve\`: the password is whatever the environment it
// was spawned with names (see ensureOpenCodeServer).
const expected = 'Basic ' + Buffer.from('opencode:' + (process.env.OPENCODE_SERVER_PASSWORD || ${JSON.stringify(password)})).toString('base64')
const server = http.createServer((req, res) => {
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  if (req.headers.authorization !== expected) return send(401, { error: 'unauthorized' })
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/global/health') return send(200, { healthy: true })
  if (url.pathname === '/session/ses_fail_cli') return send(200, { id: 'ses_fail_cli', directory: process.cwd(), title: 't' })
  send(404, { error: 'not found' })
})
server.listen(0, '127.0.0.1', () => console.log('opencode server listening on http://127.0.0.1:' + server.address().port))
`,
    )
    writeFileSync(
      path.join(bin, 'opencode'),
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(root, 'fake-opencode.cjs'))} "$@"\n`,
    )
    writeFileSync(path.join(bin, 'lsof'), '#!/bin/sh\nexit 0\n')
    chmodSync(path.join(bin, 'opencode'), 0o755)
    chmodSync(path.join(bin, 'lsof'), 0o755)
    const bundle = fileURLToPath(new URL('../../plugin/bridge/remote-control-bridge.cjs', import.meta.url))

    const bridge = spawn(
      process.execPath,
      [bundle, 'start', '--relay', await closedUrl(), '--session-id', 'ses_fail_cli'],
      {
        cwd: root,
        env: {
          ...process.env,
          HOME: cliHome,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
          OPENCODE_SERVER_USERNAME: 'opencode',
          OPENCODE_SERVER_PASSWORD: password,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    children.push(bridge)
    let output = ''
    bridge.stdout!.on('data', (chunk) => (output += chunk))
    bridge.stderr!.on('data', (chunk) => (output += chunk))
    let serverPid: number | undefined
    try {
      const exited = await waitForExit(bridge, 15_000)
      serverPid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : undefined
      expect(output).toContain('bridge start failed')
      // It did spawn a server (otherwise this proves nothing)...
      expect(serverPid).toBeGreaterThan(0)
      // ...and neither the bridge nor that server outlives the failure.
      expect(exited).toBe(true)
      expect(bridge.exitCode).toBe(1)
      expect(await until(() => !alive(serverPid), 5000)).toBe(true)
    } finally {
      if (bridge.exitCode === null && bridge.signalCode === null) bridge.kill('SIGKILL')
      if (alive(serverPid)) process.kill(serverPid!, 'SIGKILL')
      rmSync(root, { recursive: true, force: true })
    }
  },
  30_000,
)
