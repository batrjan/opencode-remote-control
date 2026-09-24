import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * The plugin used to pin `https://opencode.b4tr.net` with no override, so a
 * self-hosted relay was unreachable from the slash commands — and it left the
 * bridge log (share URL + `CODE:`) in the home directory after the share it
 * belonged to had stopped.
 *
 * The child_process mock keeps `runAction('stop')` off the network: the real
 * bridge binary ships inside the package, so an unmocked stop would actually
 * dial the relay.
 */
const spawned = vi.hoisted(() => ({ calls: [] as { file: string; args: string[] }[] }))

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  execFile: vi.fn((file: string, args: string[], _opts: unknown, cb: (e: Error | null, o: string, s: string) => void) => {
    spawned.calls.push({ file, args })
    cb(null, 'Remote control stopped.', '')
  }),
}))

// @ts-expect-error — the plugin is plain ESM JavaScript, no types.
import { clearLog, logPath, relayUrl, runAction, RELAY } from '../../plugin/bridge-runner.js'

const PUBLIC_RELAY = 'https://opencode.b4tr.net'

let warn: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  spawned.calls.length = 0
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warn.mockRestore()
})

test('falls back to the public relay when nothing is set', () => {
  expect(relayUrl({})).toBe(PUBLIC_RELAY)
  // An empty or whitespace value is "unset", not a broken override.
  expect(relayUrl({ OPENCODE_REMOTE_CONTROL_RELAY: '' })).toBe(PUBLIC_RELAY)
  expect(relayUrl({ REMOTE_CONTROL_RELAY: '   ' })).toBe(PUBLIC_RELAY)
  expect(warn).not.toHaveBeenCalled()
  // The legacy constant still names the same default for old importers.
  expect(RELAY).toBe(PUBLIC_RELAY)
})

test('honours OPENCODE_REMOTE_CONTROL_RELAY, then REMOTE_CONTROL_RELAY', () => {
  expect(relayUrl({ OPENCODE_REMOTE_CONTROL_RELAY: 'https://relay.example' })).toBe('https://relay.example')
  expect(relayUrl({ REMOTE_CONTROL_RELAY: 'http://localhost:8787' })).toBe('http://localhost:8787')
  // Both set: the namespaced one wins.
  expect(
    relayUrl({ OPENCODE_REMOTE_CONTROL_RELAY: 'https://mine.example', REMOTE_CONTROL_RELAY: 'https://other.example' }),
  ).toBe('https://mine.example')
  expect(warn).not.toHaveBeenCalled()
})

test('strips trailing slashes — the bridge appends its own paths', () => {
  expect(relayUrl({ OPENCODE_REMOTE_CONTROL_RELAY: 'https://relay.example/' })).toBe('https://relay.example')
  expect(relayUrl({ OPENCODE_REMOTE_CONTROL_RELAY: 'https://relay.example///' })).toBe('https://relay.example')
  expect(relayUrl({ OPENCODE_REMOTE_CONTROL_RELAY: '  https://relay.example/base/  ' })).toBe('https://relay.example/base')
})

test('rejects anything that is not http(s) and says so', () => {
  for (const bad of ['javascript:alert(1)', 'ftp://x', 'file:///etc/passwd', 'relay.example', 'https://']) {
    expect(relayUrl({ OPENCODE_REMOTE_CONTROL_RELAY: bad })).toBe(PUBLIC_RELAY)
  }
  expect(warn).toHaveBeenCalledTimes(5)
  expect(String(warn.mock.calls[0]?.[0])).toContain('javascript:alert(1)')
})

/** Give the module a private HOME so logPath() points inside a temp dir. */
function withTempHome(run: (home: string, log: string) => void) {
  const home = mkdtempSync(path.join(tmpdir(), 'rc-relay-'))
  const previous = process.env.HOME
  process.env.HOME = home
  try {
    const log = logPath()
    expect(log.startsWith(home)).toBe(true)
    run(home, log)
  } finally {
    if (previous === undefined) delete process.env.HOME
    else process.env.HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
}

function writeLog(file: string) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, 'https://relay.example/ses_abc\nCODE: ZZZ999\n', { mode: 0o600 })
}

test('clearLog wipes the access code out of an existing log', () => {
  withTempHome((_home, log) => {
    writeLog(log)
    expect(readFileSync(log, 'utf8')).toContain('CODE:')
    expect(clearLog(log)).toBe(true)
    expect(existsSync(log)).toBe(false)
  })
})

test('clearLog is a silent no-op when there is no log', () => {
  withTempHome((_home, log) => {
    expect(existsSync(log)).toBe(false)
    expect(() => clearLog(log)).not.toThrow()
    expect(clearLog(log)).toBe(true)
  })
})

test('clearLog reports failure instead of throwing', () => {
  withTempHome((home) => {
    // A directory where the log should be: rmSync refuses it (not recursive).
    const asDir = path.join(home, 'log-dir')
    mkdirSync(path.join(asDir, 'child'), { recursive: true })
    expect(clearLog(asDir)).toBe(false)
  })
})

// Awaited inline rather than through withTempHome: runAction resolves the log
// path when the stop finishes, so HOME must still point at the temp dir then —
// restoring it early would aim the cleanup at the real ~/.agents log.
test('stop uses the configured relay and scrubs the log afterwards', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'rc-relay-'))
  const previousHome = process.env.HOME
  const previousRelay = process.env.OPENCODE_REMOTE_CONTROL_RELAY
  process.env.HOME = home
  process.env.OPENCODE_REMOTE_CONTROL_RELAY = 'http://localhost:8787/'
  try {
    const log = logPath()
    expect(log.startsWith(home)).toBe(true)
    writeLog(log)
    const out = await runAction('stop')
    expect(out).toBe('Remote control stopped.')
    expect(spawned.calls[0]?.args).toContain('http://localhost:8787')
    expect(spawned.calls[0]?.args).not.toContain(PUBLIC_RELAY)
    expect(existsSync(log)).toBe(false)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousRelay === undefined) delete process.env.OPENCODE_REMOTE_CONTROL_RELAY
    else process.env.OPENCODE_REMOTE_CONTROL_RELAY = previousRelay
    rmSync(home, { recursive: true, force: true })
  }
})
