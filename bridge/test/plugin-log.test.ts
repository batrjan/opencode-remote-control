import { expect, test } from 'vitest'
// @ts-expect-error — the TUI plugin is plain ESM JavaScript, no types.
import { parseBridgeLog } from '../../plugin/bridge-runner.js'

/**
 * The plugin shows the share URL + code from the bridge's log file. The bridge
 * spawns its own `opencode serve` (the TUI has no HTTP port), so that log can
 * hold server output too: taking the first two lines showed log noise instead
 * of the code, and any line matching /error/ aborted the start.
 */

const NOISE = [
  'timestamp=2026-09-06T12:41:41.394Z level=INFO message=loading path=/Users/x/.config/opencode/config.json',
  'timestamp=2026-09-06T12:41:41.653Z level=INFO message="enabled LSP servers" serverIds="zls, yaml-ls"',
].join('\n')

test('returns the URL and CODE lines even when server logs come first', () => {
  const log = `${NOISE}\nhttps://relay.example/ses_abc\nCODE: ZZZ999\n`
  expect(parseBridgeLog(log)).toEqual({
    ready: 'https://relay.example/ses_abc\nCODE: ZZZ999',
    failure: undefined,
  })
})

test('picks the URL closest to the CODE line', () => {
  const log = ['https://old.example/ses_stale', NOISE, 'https://relay.example/ses_abc', 'CODE: ABC123'].join('\n')
  expect(parseBridgeLog(log).ready).toBe('https://relay.example/ses_abc\nCODE: ABC123')
})

test('a server log line mentioning an error is not a bridge failure', () => {
  const log = 'timestamp=2026-09-06T12:41:41Z level=ERROR message="failed to load plugin" path=/x.js'
  expect(parseBridgeLog(log)).toEqual({ ready: undefined, failure: undefined })
})

test('reports the bridge own failure lines', () => {
  expect(parseBridgeLog('bridge start failed: relay unreachable').failure).toBe(
    'bridge start failed: relay unreachable',
  )
  expect(parseBridgeLog(`${NOISE}\nerror: no opencode sessions found in /tmp`).failure).toBe(
    'error: no opencode sessions found in /tmp',
  )
})

test('a failure after the code is ignored — the share is already up', () => {
  const log = 'https://relay.example/ses_abc\nCODE: ABC123\nerror: something later'
  expect(parseBridgeLog(log).ready).toBe('https://relay.example/ses_abc\nCODE: ABC123')
  expect(parseBridgeLog(log).failure).toBeUndefined()
})

test('still waiting while the log is empty or has no code yet', () => {
  for (const log of ['', '   ', NOISE]) {
    expect(parseBridgeLog(log)).toEqual({ ready: undefined, failure: undefined })
  }
})

test('a code with no URL line still resolves', () => {
  expect(parseBridgeLog('CODE: ABC123').ready).toBe('CODE: ABC123')
})

test('the bridge log (share URL + access code) is private to the user, never /tmp', async () => {
  const { closeSync, mkdtempSync, rmSync, statSync, writeFileSync, chmodSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const { logPath, openLog } = await import('../../plugin/bridge-runner.js')
  const home = mkdtempSync(path.join(tmpdir(), 'rc-home-'))
  try {
    const file = logPath({ HOME: home })
    expect(file.startsWith(home)).toBe(true)
    // What the original bug was: a FIXED name directly in the shared temp
    // directory — world-readable, and open to a symlink swap on a multi-user
    // box. The log must sit in the user's own state directory instead. Asserted
    // as "not loose in the temp root" rather than "not under /tmp", because the
    // fake HOME above IS a temp directory and on Linux tmpdir() is /tmp, which
    // made the old spelling of this check fail on its own fixture.
    expect(path.dirname(file)).not.toBe(tmpdir())
    expect(path.dirname(file)).toBe(path.join(home, '.agents', 'skills', 'remote-control', 'state'))
    // Fresh: dir 0700, file 0600.
    closeSync(openLog(file))
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    // A leftover file with loose perms (older version) is tightened, not kept.
    writeFileSync(file, 'old')
    chmodSync(file, 0o644)
    closeSync(openLog(file))
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(file).size).toBe(0) // opened for write → truncated
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
