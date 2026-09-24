import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { config as relayConfig } from '../../relay/src/config'
import { startServer } from '../../relay/src/server'
import { opencodeAuthHeader } from '../src/config'
import { startBridge } from '../src/index'
import { RelayClient } from '../src/relay'

/**
 * A share must run on a server that really holds the session it shares.
 *
 * Detection used to adopt the FIRST listening port whose /global/health
 * answered `{healthy:true}`, and nothing else was asked of it. Anything on the
 * machine that answers that one route — a leftover test stub, a dev server, a
 * process someone else started as this user — therefore became the upstream of
 * the owner's share whenever it listened on a lower pid than the real opencode.
 * Observed in production: two stub HTTP servers from an earlier test made
 * `/remote-control/start` "succeed" (the relay registered the session, status
 * said "bridge: connected") while every viewer request went to the stranger,
 * which answered 401 — the viewer saw "Something went wrong" and the owner saw
 * a working share. The stranger also received the bridge's Authorization
 * header, i.e. the owner's OPENCODE_SERVER_PASSWORD, which opens their real
 * opencode — a session-creating, shell-running API.
 *
 * Stand-ins: an in-process relay, opencode stand-ins that hold given sessions,
 * a stranger that answers only the health route, a fake `opencode serve` on
 * PATH, and an `lsof` that lists only what a test asks for, so no real server
 * on this machine decides a result. POSIX only.
 */

const API_KEY = 'test-relay-key'
process.env.RELAY_API_KEY = API_KEY
/** The owner's own server password — what a stranger must never be handed. */
const OWNER_PASSWORD = 'owner-server-password-42'

let relay: Server
let relayUrl: string
let root: string
let spawnLog: string
let sessionsFile: string
const saved: Record<string, string | undefined> = {}
const savedRegistrationsPerWindow = relayConfig.registrationsPerWindow
const ENV_KEYS = [
  'HOME',
  'PATH',
  'FAKE_LSOF_LINES',
  'OPENCODE_SERVER_USERNAME',
  'OPENCODE_SERVER_PASSWORD',
  'OPENCODE_REMOTE_CONTROL_PORT',
] as const
const servers: Server[] = []
/** Registrations made by the tests themselves, removed after each test. */
const registrations: { id: string; token: string }[] = []

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** One request a stand-in answered: the path, and what credentials it carried. */
interface Seen {
  path: string
  authorization?: string
}

interface Stub {
  port: number
  seen: Seen[]
}

/** A listener line as `lsof -iTCP -sTCP:LISTEN -P` prints it. */
function lsofLine(pid: number, port: number): string {
  return `node ${pid} user 20u IPv4 0x0 0t0 TCP 127.0.0.1:${port} (LISTEN)`
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

/** The sessions the fake `opencode serve` on PATH lists once it is spawned. */
function listSessions(ids: string[]) {
  writeFileSync(sessionsFile, JSON.stringify(ids.map((id) => session(id))))
}

function session(id: string) {
  return { id, directory: process.cwd(), title: id, time: { created: 1_000 } }
}

async function listen(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void) {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

/**
 * A stranger: any process of this user that answers the health route and
 * nothing else — the leftover stub of the production incident, a dev server, a
 * dependency that started one. It authenticates nobody, so whatever the bridge
 * sends it, it keeps.
 */
async function strangerServer(): Promise<Stub> {
  const seen: Seen[] = []
  const port = await listen((req, res) => {
    seen.push({ path: req.url ?? '', authorization: req.headers.authorization })
    const url = new URL(req.url ?? '', 'http://x')
    if (url.pathname === '/global/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ healthy: true }))
      return
    }
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'unauthorized' }))
  })
  return { port, seen }
}

/** An opencode stand-in holding `ids`, behind the owner's password when `secured`. */
async function opencodeServer(ids: string[], { secured = false }: { secured?: boolean } = {}): Promise<Stub> {
  const seen: Seen[] = []
  const port = await listen((req, res) => {
    seen.push({ path: req.url ?? '', authorization: req.headers.authorization })
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    // opencode 1.18.31 with OPENCODE_SERVER_PASSWORD set asks for HTTP Basic on
    // every route, the health one included (verified against the real binary).
    if (secured && req.headers.authorization !== opencodeAuthHeader()) return send(401, { error: 'unauthorized' })
    const url = new URL(req.url ?? '', 'http://x')
    if (url.pathname === '/global/health') return send(200, { healthy: true })
    if (url.pathname === '/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(': connected\n\n')
      return
    }
    if (url.pathname === '/session') return send(200, ids.map(session))
    const m = /^\/session\/([^/]+)$/.exec(url.pathname)
    if (m) return ids.includes(decodeURIComponent(m[1]!)) ? send(200, session(decodeURIComponent(m[1]!))) : send(404, {})
    send(404, {})
  })
  return { port, seen }
}

/**
 * Whether the share itself ran on this stand-in.
 *
 * The bridge subscribes to the event stream of the server it runs on and of no
 * other, so `/event` is the mark of the server that serves the share — as
 * opposed to one that was merely asked whether it qualifies (health, and the
 * session question detection now puts to a candidate).
 */
function ranTheShare(stub: Stub): boolean {
  return stub.seen.some((r) => r.path.startsWith('/event'))
}

/** Whether a stand-in was handed the credential that opens the owner's opencode. */
function learnedThePassword(stub: Stub): boolean {
  const basic = Buffer.from(`opencode:${OWNER_PASSWORD}`).toString('base64')
  return stub.seen.some((r) => (r.authorization ?? '').includes(basic))
}

beforeAll(async () => {
  for (const key of ENV_KEYS) saved[key] = process.env[key]
  root = mkdtempSync(path.join(tmpdir(), 'rc-stranger-'))
  const home = path.join(root, 'home')
  const bin = path.join(root, 'bin')
  const lib = path.join(root, 'lib')
  spawnLog = path.join(root, 'spawned.txt')
  sessionsFile = path.join(root, 'sessions.json')
  for (const dir of [home, bin, lib]) mkdirSync(dir)
  listSessions([])
  // State files go to a private HOME, never the real one.
  process.env.HOME = home
  process.env.OPENCODE_SERVER_USERNAME = 'opencode'
  process.env.OPENCODE_SERVER_PASSWORD = OWNER_PASSWORD
  // A fake `opencode serve`: honours the password it is started with, exactly
  // as the real one does, and holds whatever sessions the test wrote.
  writeFileSync(
    path.join(lib, 'opencode'),
    `
const http = require('node:http')
const fs = require('node:fs')
if (process.argv[2] !== 'serve') process.exit(2)
const password = process.env.OPENCODE_SERVER_PASSWORD ?? ''
const expected = 'Basic ' + Buffer.from((process.env.OPENCODE_SERVER_USERNAME ?? 'opencode') + ':' + password).toString('base64')
const server = http.createServer((req, res) => {
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  if (password !== '' && req.headers.authorization !== expected) return send(401, { error: 'unauthorized' })
  const url = new URL(req.url, 'http://x')
  const sessions = JSON.parse(fs.readFileSync(${JSON.stringify(sessionsFile)}, 'utf8'))
  if (url.pathname === '/global/health') return send(200, { healthy: true })
  if (url.pathname === '/event') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': connected\\n\\n'); return }
  if (url.pathname === '/session') return send(200, sessions)
  const m = /^\\/session\\/([^/]+)$/.exec(url.pathname)
  if (m) { const s = sessions.find((x) => x.id === decodeURIComponent(m[1])); return s ? send(200, s) : send(404, {}) }
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
  // Lists only what a test asks for, so a real opencode on this machine never decides a result.
  writeFileSync(path.join(bin, 'lsof'), '#!/bin/sh\n[ -n "$FAKE_LSOF_LINES" ] && printf \'%s\\n\' "$FAKE_LSOF_LINES"\nexit 0\n')
  chmodSync(path.join(bin, 'opencode'), 0o755)
  chmodSync(path.join(bin, 'lsof'), 0o755)
  process.env.PATH = `${bin}${path.delimiter}${saved.PATH ?? ''}`
  ;(relayConfig as { registrationsPerWindow: number }).registrationsPerWindow = 100
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
  ;(relayConfig as { registrationsPerWindow: number }).registrationsPerWindow = savedRegistrationsPerWindow
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  rmSync(root, { recursive: true, force: true })
})

test.skipIf(process.platform === 'win32')(
  'a share with a session id runs on the server that has it, not on a stranger listed first — and the stranger is handed no password',
  async () => {
    const id = 'ses_stranger_first'
    const stranger = await strangerServer()
    const opencode = await opencodeServer([id], { secured: true })
    // The stranger is listed first, as the older process on a real machine is.
    process.env.FAKE_LSOF_LINES = `${lsofLine(process.pid, stranger.port)}\n${lsofLine(process.pid, opencode.port)}`
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const handle = await startBridge(relayUrl, API_KEY, { sessionId: id })
    try {
      expect({
        shareRunsOnOpencode: ranTheShare(opencode),
        strangerRanTheShare: ranTheShare(stranger),
        // Whatever it answers, a stranger must never learn the credential that
        // opens the owner's real opencode.
        strangerLearnedThePassword: learnedThePassword(stranger),
      }).toEqual({ shareRunsOnOpencode: true, strangerRanTheShare: false, strangerLearnedThePassword: false })
    } finally {
      await handle.stop()
    }
  },
  30_000,
)

test.skipIf(process.platform === 'win32')(
  'a share that picks its own session runs on the server that has one, not on a stranger listed first',
  async () => {
    const id = 'ses_stranger_picked'
    const stranger = await strangerServer()
    const opencode = await opencodeServer([id], { secured: true })
    process.env.FAKE_LSOF_LINES = `${lsofLine(process.pid, stranger.port)}\n${lsofLine(process.pid, opencode.port)}`
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const handle = await startBridge(relayUrl, API_KEY)
    try {
      expect({
        session: handle.session_id,
        shareRunsOnOpencode: ranTheShare(opencode),
        strangerRanTheShare: ranTheShare(stranger),
        strangerLearnedThePassword: learnedThePassword(stranger),
      }).toEqual({ session: id, shareRunsOnOpencode: true, strangerRanTheShare: false, strangerLearnedThePassword: false })
    } finally {
      await handle.stop()
    }
  },
  30_000,
)

test.skipIf(process.platform === 'win32')(
  'a stranger is no reason not to start a server of our own: the share runs on the spawned one',
  async () => {
    const id = 'ses_only_stranger'
    listSessions([id])
    const stranger = await strangerServer()
    process.env.FAKE_LSOF_LINES = lsofLine(process.pid, stranger.port)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const before = spawned().size

    const handle = await startBridge(relayUrl, API_KEY, { sessionId: id })
    try {
      expect({
        spawnedItsOwn: spawned().size === before + 1,
        strangerRanTheShare: ranTheShare(stranger),
        strangerLearnedThePassword: learnedThePassword(stranger),
      }).toEqual({ spawnedItsOwn: true, strangerRanTheShare: false, strangerLearnedThePassword: false })
    } finally {
      await handle.stop()
    }
  },
  30_000,
)

test.skipIf(process.platform === 'win32')(
  'an opencode that does not hold the shared session is passed over for the one that does',
  async () => {
    const id = 'ses_other_server'
    const elsewhere = await opencodeServer(['ses_someone_elses_project'], { secured: true })
    const holder = await opencodeServer([id], { secured: true })
    process.env.FAKE_LSOF_LINES = `${lsofLine(process.pid, elsewhere.port)}\n${lsofLine(process.pid, holder.port)}`
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const before = spawned().size

    const handle = await startBridge(relayUrl, API_KEY, { sessionId: id })
    try {
      expect({
        shareRunsOnTheHolder: ranTheShare(holder),
        theOtherRanTheShare: ranTheShare(elsewhere),
        spawnedAnything: spawned().size !== before,
      }).toEqual({ shareRunsOnTheHolder: true, theOtherRanTheShare: false, spawnedAnything: false })
    } finally {
      await handle.stop()
    }
  },
  30_000,
)

test.skipIf(process.platform === 'win32')(
  'a session two servers both hold is served by the first of them, with nothing started for it',
  async () => {
    const id = 'ses_on_two_servers'
    const first = await opencodeServer([id], { secured: true })
    const second = await opencodeServer([id], { secured: true })
    process.env.FAKE_LSOF_LINES = `${lsofLine(process.pid, first.port)}\n${lsofLine(process.pid, second.port)}`
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const before = spawned().size

    const handle = await startBridge(relayUrl, API_KEY, { sessionId: id })
    try {
      expect({
        shareRunsOnTheFirst: ranTheShare(first),
        secondRanTheShare: ranTheShare(second),
        spawnedAnything: spawned().size !== before,
      }).toEqual({ shareRunsOnTheFirst: true, secondRanTheShare: false, spawnedAnything: false })
    } finally {
      await handle.stop()
    }
  },
  30_000,
)

/*
 * The escape hatch.
 *
 * Detection now refuses a server that cannot show it holds the session, and
 * the owner had no way to overrule it: `--port` exists, but the path that
 * needs it most — the plugin, which runs `start` itself — passes no flags.
 * OPENCODE_REMOTE_CONTROL_PORT names the server instead, and is taken as
 * given: neither scanned for nor questioned, exactly as `--port` is.
 */
test.skipIf(process.platform === 'win32')(
  'a port named in the environment is used as it stands, with nothing scanned and nothing spawned',
  async () => {
    const id = 'ses_named_port'
    const opencode = await opencodeServer([id], { secured: true })
    // lsof lists nothing at all: without the setting this start would spawn a server.
    process.env.OPENCODE_REMOTE_CONTROL_PORT = String(opencode.port)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const before = spawned().size

    const handle = await startBridge(relayUrl, API_KEY, { sessionId: id })
    try {
      expect({ shareRunsOnTheNamedServer: ranTheShare(opencode), spawnedAnything: spawned().size !== before }).toEqual({
        shareRunsOnTheNamedServer: true,
        spawnedAnything: false,
      })
    } finally {
      await handle.stop()
      delete process.env.OPENCODE_REMOTE_CONTROL_PORT
    }
  },
  30_000,
)

test.skipIf(process.platform === 'win32')(
  'a setting that is not a port is said out loud and detection decides, rather than the share not starting',
  async () => {
    const id = 'ses_bad_named_port'
    const opencode = await opencodeServer([id], { secured: true })
    process.env.OPENCODE_REMOTE_CONTROL_PORT = 'yes please'
    process.env.FAKE_LSOF_LINES = lsofLine(process.pid, opencode.port)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const handle = await startBridge(relayUrl, API_KEY, { sessionId: id })
    try {
      expect({
        shareRunsOnTheDetectedServer: ranTheShare(opencode),
        said: warn.mock.calls.some(([line]) => String(line).includes('OPENCODE_REMOTE_CONTROL_PORT')),
      }).toEqual({ shareRunsOnTheDetectedServer: true, said: true })
    } finally {
      await handle.stop()
      delete process.env.OPENCODE_REMOTE_CONTROL_PORT
    }
  },
  30_000,
)
