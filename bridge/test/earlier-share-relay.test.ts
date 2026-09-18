import { afterAll, afterEach, beforeAll, expect, test } from 'vitest'
import { execFile, spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import { opencodeAuthHeader } from '../src/config'
import { startBridge, stopBridge } from '../src/index'
import { loadSessionState, saveSessionState } from '../src/state'

/**
 * A recorded share's bridge_token goes only to the relay that share was
 * registered on.
 *
 * `start` settling a dead earlier share, `stop` and `status` all read the
 * bridge_token from the share's state file, and all of them sent it to the
 * relay of the CURRENT command — whatever `--relay` or REMOTE_CONTROL_RELAY
 * said now — not to the relay the state records. The owner_key is bound to the
 * relay's origin precisely so that a self-hosted or mistyped relay learns
 * nothing usable on another one, yet an owner who shared on the public relay,
 * lost the bridge (-9, a reboot) and then pointed the plugin at another relay
 * handed that relay the live credential of the public share: its operator
 * could connect as that share's bridge (serving its viewers, reading their
 * prompts) or read its directory and title. And the share itself was never
 * ended: the wrong relay answered 404, which reads as "already gone".
 *
 * Both relays are local stubs that record every request, so nothing leaves
 * the machine; state files go to a private HOME.
 */

const BUNDLE = fileURLToPath(new URL('../../plugin/bridge/remote-control-bridge.cjs', import.meta.url))

interface SeenRequest {
  method: string
  path: string
  token?: string
  apiKey?: string
}

interface StubRelay {
  url: string
  server: Server
  seen: SeenRequest[]
  /** session id -> the bridge_token this relay issued for it. */
  sessions: Map<string, string>
}

/**
 * A relay that holds the sessions it is given, ends one on a DELETE with its
 * own token, shows the owner-only fields to that token, and refuses every new
 * registration (these tests are about what happens before one).
 */
async function stubRelay(): Promise<StubRelay> {
  const seen: SeenRequest[] = []
  const sessions = new Map<string, string>()
  const server = createServer((req, res) => {
    const token = req.headers['x-bridge-token']
    const apiKey = req.headers['x-api-key']
    seen.push({
      method: req.method ?? '',
      path: req.url ?? '',
      ...(typeof token === 'string' ? { token } : {}),
      ...(typeof apiKey === 'string' ? { apiKey } : {}),
    })
    const send = (status: number, body?: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(body === undefined ? undefined : JSON.stringify(body))
    }
    if (req.url === '/health') return send(200, { ok: true })
    if (req.method === 'POST' && req.url === '/api/sessions') return send(503, { error: 'relay full' })
    const id = /^\/api\/sessions\/([^/?]+)$/.exec(req.url ?? '')?.[1]
    const issued = id === undefined ? undefined : sessions.get(decodeURIComponent(id))
    if (issued === undefined) return send(404, { error: 'session not found' })
    if (req.method === 'DELETE') {
      if (token !== issued) return send(404, { error: 'session not found' })
      sessions.delete(decodeURIComponent(id!))
      return send(204)
    }
    const now = Date.now()
    return send(200, {
      session_id: decodeURIComponent(id!),
      status: 'active',
      created_at: now,
      last_seen: now,
      viewer_count: 0,
      bridge_connected: false,
      ...(token === issued ? { directory: '/owner/only/directory', title: 'owner-only title' } : {}),
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, seen, sessions }
}

let root: string
let home: string
let fakeBin: string
let opencode: Server
let opencodeUrl: string
/** Where the earlier share was registered, and the relay the owner switched to since. */
let original: StubRelay
let other: StubRelay
const savedHome = process.env.HOME

/** The pid of a process that has already exited: what a state file names after a crash or a reboot. */
async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await new Promise((resolve) => child.once('exit', resolve))
  return child.pid!
}

/** A share of `id` registered on `relay`, recorded in this machine's state the way `start` records it. */
function recordShare(id: string, relay: StubRelay, recordedUrl: string, pid?: number) {
  const bridge_token = `token-issued-by-the-original-relay-for-${id}`
  relay.sessions.set(id, bridge_token)
  saveSessionState({
    session_id: id,
    access_code: 'XXXXXX',
    bridge_token,
    relay: recordedUrl,
    started_at: Date.now(),
    ...(pid === undefined ? {} : { pid }),
  })
  return bridge_token
}

function runCli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BUNDLE, ...args],
      {
        env: { ...process.env, ...env, HOME: home, PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}` },
        timeout: 15_000,
      },
      (err, stdout) => resolve({ code: err ? Number((err as { code?: unknown }).code ?? 1) : 0, stdout: String(stdout) }),
    )
  })
}

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'rc-earlier-share-relay-'))
  home = path.join(root, 'home')
  mkdirSync(home)
  // State files and the install's owner.key go to a private HOME, never the real one.
  process.env.HOME = home
  // `status` scans the machine's listeners for an opencode; a stub lsof that
  // lists nothing keeps the test off every other process's ports.
  fakeBin = path.join(root, 'bin')
  mkdirSync(fakeBin)
  writeFileSync(path.join(fakeBin, 'lsof'), '#!/bin/sh\nexit 0\n')
  chmodSync(path.join(fakeBin, 'lsof'), 0o755)
  opencode = createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    // Same basic auth as the real server, so detect.test.ts (parallel worker)
    // never mistakes this mock for a healthy opencode.
    if (req.headers.authorization !== opencodeAuthHeader()) return send(401, { error: 'unauthorized' })
    const m = /^\/session\/([^/?]+)$/.exec(req.url ?? '')
    if (m) return send(200, { id: decodeURIComponent(m[1]!), directory: root, title: 'moved' })
    send(404, { error: 'not found' })
  })
  await new Promise<void>((resolve) => opencode.listen(0, '127.0.0.1', resolve))
  opencodeUrl = `http://127.0.0.1:${(opencode.address() as AddressInfo).port}`
})

afterEach(async () => {
  for (const relay of [original, other]) {
    if (!relay) continue
    relay.server.closeAllConnections()
    await new Promise((resolve) => relay.server.close(resolve))
  }
})

afterAll(async () => {
  opencode.closeAllConnections()
  await new Promise((resolve) => opencode.close(resolve))
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  rmSync(root, { recursive: true, force: true })
})

async function twoRelays() {
  original = await stubRelay()
  other = await stubRelay()
}

// POSIX only: whether the earlier bridge is gone comes from `ps`.
test.skipIf(process.platform === 'win32')(
  'start through another relay ends a dead earlier share on its own relay, and never shows the new one its token',
  async () => {
    await twoRelays()
    const token = recordShare('ses_moved_start', original, original.url, await exitedPid())

    // The other relay refuses the registration: what matters here is what
    // settling the earlier share sent where, before it.
    await expect(startBridge(other.url, 'key-for-the-other-relay', { opencodeUrl, sessionId: 'ses_moved_start' })).rejects.toThrow(
      /503/,
    )

    expect(other.seen.filter((r) => r.token !== undefined)).toEqual([])
    // Ended where it lived, with its own token — and without the legacy key
    // meant for the other relay.
    expect(original.seen).toContainEqual({ method: 'DELETE', path: '/api/sessions/ses_moved_start', token })
    expect(original.sessions.has('ses_moved_start')).toBe(false)
    expect(loadSessionState('ses_moved_start')).toBeUndefined()
  },
)

test('stop through another relay ends the share on the relay it was registered on', async () => {
  await twoRelays()
  const token = recordShare('ses_moved_stop', original, original.url)

  await expect(stopBridge(other.url, 'ses_moved_stop', 'key-for-the-other-relay')).resolves.toBeUndefined()

  expect(other.seen.filter((r) => r.token !== undefined)).toEqual([])
  expect(original.seen).toEqual([{ method: 'DELETE', path: '/api/sessions/ses_moved_stop', token }])
  expect(original.sessions.has('ses_moved_stop')).toBe(false)
  expect(loadSessionState('ses_moved_stop')).toBeUndefined()
})

test('the same relay spelled another way is still the same relay: its api key and URL as given are kept', async () => {
  await twoRelays()
  const token = recordShare('ses_same_relay', original, `${original.url}/`)

  await expect(stopBridge(original.url, 'ses_same_relay', 'key-for-this-relay')).resolves.toBeUndefined()

  expect(original.seen).toEqual([
    { method: 'DELETE', path: '/api/sessions/ses_same_relay', token, apiKey: 'key-for-this-relay' },
  ])
  expect(original.sessions.has('ses_same_relay')).toBe(false)
})

test('status through another relay asks the relay the share was registered on, and says which', async () => {
  await twoRelays()
  recordShare('ses_moved_status', original, original.url)

  const { stdout } = await runCli(['status', '--relay', other.url, '--session-id', 'ses_moved_status'])

  expect(other.seen.filter((r) => r.token !== undefined)).toEqual([])
  expect(original.seen.filter((r) => r.method === 'GET' && r.path === '/api/sessions/ses_moved_status')).toHaveLength(1)
  expect(stdout).toContain(`session ses_moved_status (relay ${original.url}): active`)
  expect(stdout).toContain('title: owner-only title')
}, 30_000)

/*
 * Asking the share's own relay made that relay a second one `status` depends
 * on — and exactly in the case it was made for, the owner has left it. When it
 * could not be reached the probe threw out of the command: the CLI died with a
 * stack trace on stderr, after "relay: ok" for the relay it was pointed at, and
 * never printed the session line or the "run stop to end it" hint for a dead
 * bridge. The plugin shows only stdout for a failed status, so the owner saw a
 * near-healthy report. A relay that accepted the connection and never answered
 * held `status` open until the plugin killed it 15 s later, with the same
 * report.
 */

// POSIX only: whether the recorded bridge is gone comes from `ps`.
test.skipIf(process.platform === 'win32')(
  'status of a dead share whose own relay is gone says so, and still says to stop it',
  async () => {
    await twoRelays()
    const token = recordShare('ses_gone_relay', original, original.url, await exitedPid())
    // The owner moved to the other relay, and the one the share lived on is down.
    original.server.closeAllConnections()
    await new Promise((resolve) => original.server.close(resolve))

    const { code, stdout } = await runCli(['status', '--relay', other.url, '--session-id', 'ses_gone_relay'])

    expect(code).toBe(1)
    expect(stdout).toContain(`relay: ok (${other.url})`)
    const port = new URL(original.url).port
    expect(stdout).toContain(
      `session ses_gone_relay (relay ${original.url}): unknown — relay ${original.url} unreachable: fetch failed (connect ECONNREFUSED 127.0.0.1:${port})`,
    )
    expect(stdout).toMatch(/bridge process: not running \(pid \d+\) — this share is stale, run stop to end it/)
    expect(other.seen.filter((r) => r.token === token)).toEqual([])
  },
  30_000,
)

test.skipIf(process.platform === 'win32')(
  'status of a dead share whose own relay never answers gives up on it in time',
  async () => {
    await twoRelays()
    // The share's own relay accepts the connection and never answers: a wedged
    // upstream, a black-holed path.
    const silent = createServer(() => {})
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve))
    const silentUrl = `http://127.0.0.1:${(silent.address() as AddressInfo).port}`
    const token = recordShare('ses_silent_relay', original, silentUrl, await exitedPid())
    try {
      const startedAt = Date.now()
      const { code, stdout } = await runCli(['status', '--relay', other.url, '--session-id', 'ses_silent_relay'], {
        REMOTE_CONTROL_RELAY_DELETE_TIMEOUT_MS: '500',
      })

      // Well inside the 15 s the plugin gives a status (and this runner's own kill).
      expect(Date.now() - startedAt).toBeLessThan(10_000)
      expect(code).toBe(1)
      expect(stdout).toContain(`session ses_silent_relay (relay ${silentUrl}): unknown — relay did not answer within 1 s`)
      expect(stdout).toMatch(/bridge process: not running \(pid \d+\) — this share is stale, run stop to end it/)
      expect(other.seen.filter((r) => r.token === token)).toEqual([])
    } finally {
      silent.closeAllConnections()
      await new Promise((resolve) => silent.close(resolve))
    }
  },
  30_000,
)
