import { afterEach, beforeEach, expect, test } from 'vitest'
import { createServer, type Server } from 'node:http'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
// @ts-expect-error — the plugin entries are plain ESM JavaScript, no types.
import { createHooks } from '../../plugin/server.js'
// @ts-expect-error — same.
import tuiPlugin from '../../plugin/remote-control.js'

/**
 * Nothing stops two shares from running on one machine — say session A shared
 * first, session B later. `/remote-control/stop` and `/remote-control/status`
 * used to reach the bridge CLI with no session id at all, and the CLI then
 * picked the share that STARTED LAST. Stop typed in A deleted B on the relay
 * and killed B's bridge, while A's access code and every viewer token stayed
 * live — and the user was told "Remote control stopped.". Status typed in A
 * reported on B.
 *
 * Runs the real plugin entries against the committed bridge bundle; the relay
 * is a local stub that records every request, so nothing leaves the machine.
 */

const STATE_DIR = ['.agents', 'skills', 'remote-control', 'state'] as const

let home: string
let relay: Server
let relayUrl: string
let seen: string[]
const saved = { HOME: process.env.HOME, PATH: process.env.PATH, RELAY: process.env.OPENCODE_REMOTE_CONTROL_RELAY }

function stateFile(id: string): string {
  return path.join(home, ...STATE_DIR, `${id}.json`)
}

/** A made-up access code per fixture share, so a log can be told apart by the code it holds. */
function codeOf(id: string): string {
  return `CODE${id.slice(-1).toUpperCase()}${id.slice(-1).toUpperCase()}`
}

/**
 * A share of `id` recorded the way `start` records one: through the stub relay,
 * which is the only relay `stop` and `status` send its token to.
 */
function share(id: string, started_at: number, fields: Record<string, unknown> = {}) {
  writeFileSync(
    stateFile(id),
    JSON.stringify({ session_id: id, access_code: codeOf(id), bridge_token: `tok-${id}`, relay: relayUrl, started_at, ...fields }),
    { mode: 0o600 },
  )
}

function logFile(): string {
  return path.join(home, ...STATE_DIR, 'bridge.log')
}

/** bridge.log the way the plugin leaves it once `id`'s share came up: its URL and its code. */
function logOf(id: string): string {
  return `http://relay.invalid/${id}\nCODE: ${codeOf(id)}\n`
}

beforeEach(async () => {
  home = mkdtempSync(path.join(tmpdir(), 'rc-stop-session-'))
  mkdirSync(path.join(home, ...STATE_DIR), { recursive: true, mode: 0o700 })

  seen = []
  relay = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`)
    if (req.url === '/health') return res.end('{}')
    const id = /^\/api\/sessions\/([^/?]+)$/.exec(req.url ?? '')?.[1]
    if (req.method === 'DELETE') {
      // ses_down: the relay is restarting behind nginx.
      res.statusCode = id === 'ses_down' ? 502 : 204
      return res.end()
    }
    if (req.method === 'GET' && (id === 'ses_A' || id === 'ses_B')) {
      res.setHeader('content-type', 'application/json')
      return res.end(
        JSON.stringify({ status: 'active', bridge_connected: true, viewer_count: 0, created_at: Date.now(), title: `title ${id}` }),
      )
    }
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve))
  relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`

  // A is the older share, B the newest — the one the old fallback always hit.
  // No pid: stop must not go signalling anything on the test machine.
  share('ses_A', Date.now() - 60_000)
  share('ses_B', Date.now())

  // `status` also scans the machine for an OpenCode server; a stub lsof that
  // lists nothing keeps whatever really runs here out of the test.
  const bin = path.join(home, 'bin')
  mkdirSync(bin)
  writeFileSync(path.join(bin, 'lsof'), '#!/bin/sh\nexit 0\n')
  chmodSync(path.join(bin, 'lsof'), 0o755)

  process.env.HOME = home
  process.env.PATH = `${bin}${path.delimiter}${saved.PATH ?? ''}`
  process.env.OPENCODE_REMOTE_CONTROL_RELAY = relayUrl
})

afterEach(async () => {
  for (const [key, value] of [
    ['HOME', saved.HOME],
    ['PATH', saved.PATH],
    ['OPENCODE_REMOTE_CONTROL_RELAY', saved.RELAY],
  ] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await new Promise((resolve) => relay.close(resolve))
  rmSync(home, { recursive: true, force: true })
})

/** Run a slash command through the server entry (desktop GUI, `opencode run`). */
async function serverCommand(command: string, sessionID: string): Promise<string> {
  const output = { parts: [] as Array<{ text: string; synthetic?: boolean }> }
  await createHooks()['command.execute.before']({ command, sessionID, arguments: '' }, output)
  return output.parts.filter((p) => !p.synthetic).map((p) => p.text).join('\n')
}

/** Load the TUI entry with the user on `route` and return its commands plus what it showed. */
async function loadTui(route: { name: string; params?: Record<string, string> }) {
  const commands = new Map<string, () => unknown>()
  const shown: string[] = []
  const api = {
    route: { current: route },
    keymap: {
      registerLayer: (layer: { commands: Array<{ name: string; run: () => unknown }> }) => {
        for (const c of layer.commands) commands.set(c.name, c.run)
      },
    },
    ui: {
      toast: (t: { message: string }) => shown.push(t.message),
      dialog: { replace: (render: () => unknown) => render(), clear: () => {} },
      DialogAlert: (props: { message: string }) => shown.push(props.message),
      DialogSelect: () => {},
    },
  }
  await tuiPlugin.tui(api)
  return { run: async (name: string) => await commands.get(name)!(), shown }
}

test('/remote-control/stop typed in session A stops A, not the share that started last', async () => {
  const text = await serverCommand('remote-control/stop', 'ses_A')
  expect(seen).toContain('DELETE /api/sessions/ses_A')
  expect(seen).not.toContain('DELETE /api/sessions/ses_B')
  expect(existsSync(stateFile('ses_A'))).toBe(false)
  expect(existsSync(stateFile('ses_B'))).toBe(true)
  expect(text).toBe('Remote control stopped.')
}, 30_000)

test('/remote-control/status typed in session A reports A', async () => {
  const text = await serverCommand('remote-control/status', 'ses_A')
  expect(seen).toContain('GET /api/sessions/ses_A')
  expect(seen).not.toContain('GET /api/sessions/ses_B')
  expect(text).toContain('session ses_A: active')
  expect(text).not.toContain('ses_B')
}, 30_000)

test('the TUI commands act on the session the user is looking at', async () => {
  const tui = await loadTui({ name: 'session', params: { sessionID: 'ses_A' } })

  await tui.run('remote-control.status')
  expect(seen).toContain('GET /api/sessions/ses_A')
  expect(seen).not.toContain('GET /api/sessions/ses_B')
  expect(tui.shown.at(-1)).toContain('title ses_A')

  await tui.run('remote-control.stop')
  expect(seen).toContain('DELETE /api/sessions/ses_A')
  expect(seen).not.toContain('DELETE /api/sessions/ses_B')
  expect(existsSync(stateFile('ses_B'))).toBe(true)
  expect(tui.shown.at(-1)).toBe('Remote control stopped.')
}, 30_000)

test('stop in a session that is not shared stops nothing and does not claim it did', async () => {
  // With the id passed through, a session with no share of its own must not
  // fall back to another one — nor report a stop that never happened while A
  // and B both stay live.
  const text = await serverCommand('remote-control/stop', 'ses_C')
  expect(seen.filter((r) => r.startsWith('DELETE'))).toEqual([])
  expect(existsSync(stateFile('ses_A'))).toBe(true)
  expect(existsSync(stateFile('ses_B'))).toBe(true)
  expect(text).not.toContain('Remote control stopped.')
  expect(text).toContain('ses_C is not shared from this machine')
}, 30_000)

test('stop in a session that is not shared leaves the log of the share that is up', async () => {
  // bridge.log holds the URL and code of the share that came up last (B), and
  // B's bridge writes why its share ended into it later. A stop in C ended
  // nothing, yet the plugin deleted the log after it all the same.
  writeFileSync(logFile(), logOf('ses_B'), { mode: 0o600 })

  const text = await serverCommand('remote-control/stop', 'ses_C')

  expect(text).toContain('ses_C is not shared from this machine')
  expect(existsSync(logFile())).toBe(true)
  expect(readFileSync(logFile(), 'utf8')).toBe(logOf('ses_B'))
}, 30_000)

test('stopping one share keeps the log of another that is up, and scrubs its own', async () => {
  // B came up after A, so bridge.log is B's. Stopping A must not take B's URL
  // and code out of it; stopping B must, since that code is spent.
  writeFileSync(logFile(), logOf('ses_B'), { mode: 0o600 })

  expect(await serverCommand('remote-control/stop', 'ses_A')).toBe('Remote control stopped.')
  expect(existsSync(stateFile('ses_A'))).toBe(false)
  expect(existsSync(logFile())).toBe(true)
  expect(readFileSync(logFile(), 'utf8')).toBe(logOf('ses_B'))

  expect(await serverCommand('remote-control/stop', 'ses_B')).toBe('Remote control stopped.')
  expect(existsSync(logFile())).toBe(false)
}, 30_000)

test('stop while the relay cannot be told still ends the share, scrubs the code and says what happened', async () => {
  // A relay restarting behind nginx answers 502. `stop` used to exit 1 before
  // touching anything local: the plugin showed "stop failed", kept the log
  // with the access code, and the bridge re-dialled until the relay was back —
  // the same share, same code, live again. The local share must end regardless,
  // and the owner must hear that the relay was not reached rather than a plain
  // "stopped".
  share('ses_down', Date.now(), { access_code: 'X' })
  const log = path.join(home, ...STATE_DIR, 'bridge.log')
  writeFileSync(log, 'https://relay.invalid/ses_down\nCODE: XXXXXX\n', { mode: 0o600 })

  const text = await serverCommand('remote-control/stop', 'ses_down')

  expect(seen).toContain('DELETE /api/sessions/ses_down')
  expect(text).not.toContain('failed:')
  expect(text).toContain('Remote control stopped on this machine')
  expect(text).toContain('relay could not be told')
  expect(text).toContain('502')
  expect(existsSync(stateFile('ses_down'))).toBe(false)
  expect(existsSync(log)).toBe(false)
  expect(existsSync(stateFile('ses_A'))).toBe(true)
}, 30_000)
