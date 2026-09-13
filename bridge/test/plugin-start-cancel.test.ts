import { afterEach, beforeEach, expect, test } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
// @ts-expect-error — the plugin is plain ESM JavaScript, no types.
import { runAction } from '../../plugin/bridge-runner.js'

/**
 * A start the plugin gives up on must not keep running behind its back.
 *
 * The plugin launches the bridge detached and, on the TUI path, the bridge
 * spawns an `opencode serve` of its own. When the plugin's wait ran out it only
 * reported a timeout: the bridge went on to register the share, printed a code
 * nobody read, and kept the server running. And the wait could run out for a
 * stage with no deadline at all — a relay registration nobody answered held
 * the bridge forever.
 *
 * End to end, the way a user hits it: the real plugin/bridge-runner.js starts
 * the committed bridge bundle against a local stub relay, with a fake `lsof`
 * that lists nothing and a fake `opencode serve` on PATH. Nothing leaves the
 * machine. POSIX only: the fakes are shell scripts, and a process group is
 * what the plugin signals.
 */

const SESSION = 'ses_cancel'
const STATE_DIR = ['.agents', 'skills', 'remote-control', 'state'] as const

type Relay = { url: string; seen: string[]; close: () => Promise<void> }

let root: string
let home: string
let relay: Relay | undefined
const saved: Record<string, string | undefined> = {}
const ENV_KEYS = [
  'HOME',
  'PATH',
  'OPENCODE_REMOTE_CONTROL_RELAY',
  'REMOTE_CONTROL_START_TIMEOUT_MS',
  'REMOTE_CONTROL_RELAY_REGISTER_TIMEOUT_MS',
  'REMOTE_CONTROL_WS_HANDSHAKE_TIMEOUT_MS',
  'FAKE_SERVE_SILENT',
] as const

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

/**
 * The fake server writes `<pid> <ppid>` on start. It is exec'd by its wrapper,
 * so the ppid is the bridge that spawned it — the only way to learn the pid of
 * a bridge that never got as far as a state file.
 */
function spawnedPids(): { serve?: number; bridge?: number } {
  try {
    const [serve, bridge] = readFileSync(path.join(root, 'serve.pids'), 'utf8').trim().split(' ').map(Number)
    return { serve, bridge }
  } catch {
    return {}
  }
}

/** Stub relay: registration answers or hangs; the bridge WebSocket upgrade always hangs. */
async function startRelay(registration: 'answer' | 'hang'): Promise<Relay> {
  const seen: string[] = []
  const held: Socket[] = []
  const server: Server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`)
    if (req.method === 'POST' && req.url === '/api/sessions') {
      if (registration === 'hang') return void held.push(req.socket)
      res.writeHead(201, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ access_code: 'NEVER1', bridge_token: 'tok', viewer_url: `/${SESSION}` }))
    }
    res.writeHead(req.method === 'DELETE' ? 204 : 404)
    res.end()
  })
  // Registered, then stuck: the upgrade is read and never answered.
  server.on('upgrade', (req, socket: Socket) => {
    seen.push(`UPGRADE ${req.url}`)
    held.push(socket)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: async () => {
      for (const socket of held) socket.destroy()
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key]
  root = mkdtempSync(path.join(tmpdir(), 'rc-start-cancel-'))
  home = path.join(root, 'home')
  const bin = path.join(root, 'bin')
  mkdirSync(home)
  mkdirSync(bin)
  writeFileSync(
    path.join(root, 'fake-opencode.cjs'),
    `
const http = require('node:http')
const fs = require('node:fs')
if (process.argv[2] !== 'serve') process.exit(2)
fs.writeFileSync(${JSON.stringify(path.join(root, 'serve.pids'))}, process.pid + ' ' + process.ppid)
const server = http.createServer((req, res) => {
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/global/health') return send(200, { healthy: true })
  if (url.pathname === '/session/${SESSION}') return send(200, { id: '${SESSION}', directory: process.cwd(), title: 'cancel' })
  send(404, {})
})
server.listen(0, '127.0.0.1', () => {
  // Silent: a cold start that has not reported its port yet.
  if (!process.env.FAKE_SERVE_SILENT) console.log('opencode server listening on http://127.0.0.1:' + server.address().port)
})
`,
  )
  writeFileSync(
    path.join(bin, 'opencode'),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(root, 'fake-opencode.cjs'))} "$@"\n`,
  )
  writeFileSync(path.join(bin, 'lsof'), '#!/bin/sh\nexit 0\n')
  chmodSync(path.join(bin, 'opencode'), 0o755)
  chmodSync(path.join(bin, 'lsof'), 0o755)
  process.env.HOME = home
  process.env.PATH = `${bin}${path.delimiter}${saved.PATH ?? ''}`
  // Nothing here may end the start on its own before the plugin does.
  process.env.REMOTE_CONTROL_WS_HANDSHAKE_TIMEOUT_MS = '600000'
  delete process.env.FAKE_SERVE_SILENT
  delete process.env.REMOTE_CONTROL_RELAY_REGISTER_TIMEOUT_MS
})

afterEach(async () => {
  // Never leave a test's processes behind, whatever the assertions said.
  const { serve, bridge } = spawnedPids()
  for (const pid of [bridge, serve]) if (alive(pid)) process.kill(pid!, 'SIGKILL')
  await relay?.close()
  relay = undefined
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  rmSync(root, { recursive: true, force: true })
})

async function start(): Promise<string> {
  try {
    return `RESOLVED ${await runAction('start', SESSION)}`
  } catch (err) {
    return String((err as Error).message)
  }
}

test.skipIf(process.platform === 'win32')(
  'a bridge still waiting for its server is cancelled together with that server',
  async () => {
    relay = await startRelay('answer')
    process.env.OPENCODE_REMOTE_CONTROL_RELAY = relay.url
    process.env.REMOTE_CONTROL_START_TIMEOUT_MS = '4000'
    process.env.FAKE_SERVE_SILENT = '1'
    const outcome = await start()
    const { serve, bridge } = spawnedPids()
    expect(serve, 'the bridge never spawned its server').toBeTruthy()
    expect(outcome).toMatch(/^start cancelled: .* Nothing is shared\.$/)
    expect(await until(() => !alive(serve) && !alive(bridge), 3000), 'bridge or its server survived the cancel').toBe(true)
    expect(relay.seen.filter((r) => r.startsWith('POST'))).toEqual([])
  },
  20_000,
)

test.skipIf(process.platform === 'win32')(
  'a share registered by a bridge that then stalls is ended on the relay',
  async () => {
    relay = await startRelay('answer')
    process.env.OPENCODE_REMOTE_CONTROL_RELAY = relay.url
    process.env.REMOTE_CONTROL_START_TIMEOUT_MS = '5000'
    const stateFile = path.join(home, ...STATE_DIR, `${SESSION}.json`)
    const outcome = await start()
    // The bridge got as far as the WebSocket, with the share registered.
    expect(relay.seen).toContain(`UPGRADE /bridge?session_id=${SESSION}`)
    expect(outcome).toMatch(/^start cancelled: .* The share it had registered was ended\.$/)
    expect(relay.seen).toContain(`DELETE /api/sessions/${SESSION}`)
    expect(existsSync(stateFile)).toBe(false)
    const { serve, bridge } = spawnedPids()
    expect(await until(() => !alive(serve) && !alive(bridge), 3000), 'bridge or its server survived the cancel').toBe(true)
  },
  20_000,
)

test.skipIf(process.platform === 'win32')(
  'a registration the relay never answers fails the start with its reason',
  async () => {
    relay = await startRelay('hang')
    process.env.OPENCODE_REMOTE_CONTROL_RELAY = relay.url
    process.env.REMOTE_CONTROL_START_TIMEOUT_MS = '10000'
    process.env.REMOTE_CONTROL_RELAY_REGISTER_TIMEOUT_MS = '1000'
    const outcome = await start()
    expect(outcome).toBe('bridge start failed: relay createSession failed: no answer within 1 s')
    const { serve, bridge } = spawnedPids()
    expect(await until(() => !alive(serve) && !alive(bridge), 5000), 'bridge or its server outlived the failure').toBe(true)
  },
  20_000,
)
