import { afterAll, beforeAll, expect, test } from 'vitest'
import { createServer, type Server } from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { AddressInfo } from 'node:net'
import { startServer } from '../../relay/src/server'
import { opencodeAuthHeader } from '../src/config'
import { startBridge } from '../src/index'
import { RelayClient } from '../src/relay'

/**
 * Quitting OpenCode must end the share it started.
 *
 * The TUI has no HTTP port, so the bridge spawns its own `opencode serve` — and
 * the watchdog only ever polled THAT server. The plugin starts the bridge
 * detached (own session, own process group), so when the user quit the TUI
 * the bridge was re-parented to init and it and its private server kept each
 * other alive indefinitely. Its pings kept the relay's `last_seen` fresh, so the
 * 24 h reaper never fired either: the access code still minted viewer tokens
 * and viewers could still run shell commands through the headless server, while
 * the README promised that quitting OpenCode ends the share.
 *
 * The share is now tied to the OpenCode process that started it
 * (`--owner-pid`, passed by the plugin): the watchdog also stops when that
 * process is gone.
 */

const API_KEY = 'test-relay-key'
process.env.RELAY_API_KEY = API_KEY
process.env.ACTIVATE_FAIL_DELAY_MS = '0'

let relay: Server
let relayUrl: string
let opencode: Server
let opencodeUrl: string

function json(res: import('node:http').ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** Stand-in for the OpenCode process a share was started from. */
function spawnOwner(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
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

/** Whether `promise` settles within `ms` — a failing test reads as false, not as a vitest timeout. */
async function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms)
  })
  try {
    return await Promise.race([promise.then(() => true as const), expired])
  } finally {
    clearTimeout(timer)
  }
}

async function until(check: () => Promise<boolean> | boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return await check()
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

test('the bridge stops and revokes the share when its owner process exits, even with opencode healthy', async () => {
  const owner = spawnOwner()
  const handle = await startBridge(relayUrl, API_KEY, {
    opencodeUrl,
    sessionId: 'sess-owner',
    healthIntervalMs: 100,
    ownerPid: owner.pid,
  })
  try {
    expect((await new RelayClient(relayUrl, API_KEY).getSession('sess-owner')).status).toBe(200)
    owner.kill('SIGKILL')
    expect(await waitForExit(owner)).toBe(true)
    // The mock opencode is still perfectly healthy: only the owner is gone.
    expect(await within(handle.closed, 2000)).toBe(true)
    expect((await new RelayClient(relayUrl, API_KEY).getSession('sess-owner')).status).toBe(404)
  } finally {
    await handle.stop()
    if (alive(owner.pid)) owner.kill('SIGKILL')
  }
})

test('a live owner and a healthy opencode keep the share up', async () => {
  const owner = spawnOwner()
  const handle = await startBridge(relayUrl, API_KEY, {
    opencodeUrl,
    sessionId: 'sess-owner-alive',
    healthIntervalMs: 100,
    ownerPid: owner.pid,
  })
  try {
    // Five watchdog ticks and then some.
    expect(await within(handle.closed, 600)).toBe(false)
    expect((await new RelayClient(relayUrl, API_KEY).getSession('sess-owner-alive')).status).toBe(200)
  } finally {
    await handle.stop()
    owner.kill('SIGKILL')
    await waitForExit(owner)
  }
})

/**
 * The same failure end to end, the way a user hits it: a stand-in "TUI" loads
 * the real plugin/bridge-runner.js and runs `start`, which launches the
 * committed bridge bundle detached. No opencode is listening (a fake `lsof`
 * reports nothing, as on the TUI path), so the bridge spawns a fake
 * `opencode serve` of its own that stays healthy throughout. Then the "TUI" is
 * killed. POSIX only: the fakes are shell scripts on PATH.
 */
test.skipIf(process.platform === 'win32')(
  'quitting the TUI ends a share started from its plugin (bridge, its opencode serve and the relay session)',
  async () => {
    const SESSION = 'sess-owner-tui'
    const root = mkdtempSync(path.join(tmpdir(), 'rc-owner-exit-'))
    const home = path.join(root, 'home')
    const bin = path.join(root, 'bin')
    mkdirSync(home)
    mkdirSync(bin)
    const password = 'owner-exit-test'
    writeFileSync(
      path.join(root, 'fake-opencode.cjs'),
      `
const http = require('node:http')
if (process.argv[2] !== 'serve') process.exit(2)
const expected = 'Basic ' + Buffer.from('opencode:' + ${JSON.stringify(password)}).toString('base64')
const session = { id: ${JSON.stringify(SESSION)}, directory: process.cwd(), title: 'owner exit', time: { created: 1 } }
const server = http.createServer((req, res) => {
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  if (req.headers.authorization !== expected) return send(401, { error: 'unauthorized' })
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/global/health') return send(200, { healthy: true })
  if (url.pathname === '/session') return send(200, [session])
  if (url.pathname === '/session/' + session.id) return send(200, session)
  if (url.pathname === '/event') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': connected\\n\\n'); return }
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
    const runner = pathToFileURL(fileURLToPath(new URL('../../plugin/bridge-runner.js', import.meta.url))).href
    writeFileSync(
      path.join(root, 'tui.mjs'),
      `
import { runAction } from ${JSON.stringify(runner)}
try {
  console.log('TUI_READY ' + JSON.stringify(await runAction('start', ${JSON.stringify(SESSION)})))
} catch (err) {
  console.log('TUI_FAILED ' + String(err && err.message || err))
}
setInterval(() => {}, 1000)
`,
    )

    const tui = spawn(process.execPath, [path.join(root, 'tui.mjs')], {
      cwd: root,
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
        OPENCODE_REMOTE_CONTROL_RELAY: relayUrl,
        OPENCODE_SERVER_USERNAME: 'opencode',
        OPENCODE_SERVER_PASSWORD: password,
        REMOTE_CONTROL_WATCHDOG_INTERVAL_MS: '200',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    tui.stdout!.on('data', (chunk) => (output += chunk))
    tui.stderr!.on('data', (chunk) => (output += chunk))
    const stateFile = path.join(home, '.agents', 'skills', 'remote-control', 'state', `${SESSION}.json`)
    let state: { pid?: number; server_pid?: number } = {}
    try {
      expect(await until(() => /TUI_(READY|FAILED)/.test(output), 30_000)).toBe(true)
      expect(output).toContain('TUI_READY')
      state = JSON.parse(readFileSync(stateFile, 'utf8'))
      expect(alive(state.pid)).toBe(true)
      expect(alive(state.server_pid)).toBe(true)
      const code = /CODE: ([A-Z0-9]+)/.exec(output)?.[1]
      expect(code).toBeTruthy()
      const activate = () =>
        fetch(`${relayUrl}/api/activate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code, session_id: SESSION }),
        })
      expect((await activate()).status).toBe(200)

      // Quit OpenCode.
      tui.kill('SIGKILL')
      expect(await waitForExit(tui)).toBe(true)

      const relayClient = new RelayClient(relayUrl, API_KEY)
      expect(await until(async () => (await relayClient.getSession(SESSION)).status === 404, 10_000)).toBe(true)
      expect((await activate()).status).not.toBe(200)
      expect(await until(() => !alive(state.pid) && !alive(state.server_pid), 10_000)).toBe(true)
      expect(existsSync(stateFile)).toBe(false)
    } finally {
      if (alive(tui.pid)) tui.kill('SIGKILL')
      // A bridge that never noticed would outlive the suite (and SIGKILL skips
      // its exit hook, so its server has to be killed on its own).
      for (const pid of [state.pid, state.server_pid]) {
        if (alive(pid)) process.kill(pid!, 'SIGKILL')
      }
      rmSync(root, { recursive: true, force: true })
    }
  },
  60_000,
)
