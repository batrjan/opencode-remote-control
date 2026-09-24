import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import type { OpencodeClient } from '../src/opencode'
import { RelayClient, RelayWSClient } from '../src/relay'

/**
 * Text the relay controls reaches the owner twice: printed by `bridge status`
 * (which the TUI runs and shows) and appended to bridge.log, which owners read
 * with `cat`. Written raw, a field of that text is not text at all — an escape
 * sequence repaints the terminal, renames its window or hides the lines around
 * itself, and a newline forges lines the bridge never printed. The same fields
 * are what the plugin puts in front of the model, so a bounded, inert field is
 * also one less way to talk to the owner's agent.
 */
const ESCAPES = ']0;PWN[2K'
const HOSTILE = {
  session_id: 'ses_tty',
  status: `active${ESCAPES}`,
  viewer_count: `${ESCAPES}12`,
  created_at: Date.now() - 60_000,
  last_seen: Date.now(),
  bridge_connected: true,
  title: `nice title${ESCAPES}\nsession ses_tty: active`,
  directory: `${ESCAPES}/home/owner/secret`,
}

const BUNDLE = fileURLToPath(new URL('../../plugin/bridge/remote-control-bridge.cjs', import.meta.url))

let root: string
let fakeBin: string
let relay: Server
let relayUrl: string

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'rc-tty-'))
  fakeBin = path.join(root, 'bin')
  mkdirSync(fakeBin)
  // `status` scans the machine's listeners; a stub lsof keeps it off them.
  writeFileSync(path.join(fakeBin, 'lsof'), '#!/bin/sh\nexit 0\n')
  chmodSync(path.join(fakeBin, 'lsof'), 0o755)
  relay = createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://x')
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(url.pathname === '/health' ? { ok: true } : HOSTILE))
  })
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve))
  relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`
})

afterAll(async () => {
  relay.closeAllConnections()
  await new Promise((resolve) => relay.close(resolve))
  rmSync(root, { recursive: true, force: true })
})

function runCli(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const home = mkdtempSync(path.join(root, 'home-'))
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BUNDLE, ...args],
      { cwd: root, env: { ...process.env, HOME: home, PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}` }, timeout: 15_000 },
      (_err, stdout, stderr) => resolve({ stdout: String(stdout), stderr: String(stderr) }),
    )
  })
}

test('a hostile relay cannot write control sequences or extra lines through `status`', async () => {
  const { stdout, stderr } = await runCli(['status', '--relay', relayUrl, '--session-id', 'ses_tty'])
  const output = stdout + stderr
  expect(output).not.toContain('')
  expect(output).not.toContain('')
  // No owner token was sent (there is no share of this session on this
  // machine), so the relay's owner-only fields are not the bridge's to print.
  expect(output).not.toMatch(/^ {2}title:/m)
  expect(output).not.toMatch(/^ {2}directory:/m)
  // …and it cannot forge a second session line through one of them either.
  expect(stdout.split('\n').filter((line) => line.startsWith('session '))).toHaveLength(1)
  // A status of the relay's own invention is not echoed as if it were one.
  expect(stdout).toContain('session ses_tty: unknown')
  // A count that is not a number is said to be unknown, not printed as NaN.
  expect(stdout).toContain('viewers: ?')
})

test('the owner-only fields are shown for the owner, stripped of what moves a cursor', async () => {
  const { body } = await new RelayClient(relayUrl).getSession('ses_tty', 'bridge-token')
  // What is left is inert: an OSC or CSI body with no introducer in front of
  // it is ordinary text, and the newline that would have forged a line is gone.
  expect(body?.title).toBe('nice title]0;PWN[2Ksession ses_tty: active')
  expect(body?.directory).toBe(']0;PWN[2K/home/owner/secret')
  expect(body?.status).toBe('unknown')
  expect(body?.viewer_count).toBeUndefined()
})

test('a refused proxy path is reported without its escape sequences', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const client = new RelayWSClient('http://relay.invalid', {} as OpencodeClient)
  ;(client as unknown as { ws: unknown }).ws = { readyState: 1, send: () => {} }
  ;(client as unknown as { boundSessionId: string }).boundSessionId = 'ses_tty'
  await (client as unknown as { onMessage(raw: unknown): Promise<void> }).onMessage(
    JSON.stringify({ type: 'proxy', request_id: 'r1', method: 'GET', path: '/x]0;PWN\nbridge: everything is fine' }),
  )
  const line = warn.mock.calls.map((call) => String(call[0])).join('\n')
  expect(line).toContain('refused a relay request outside the allowlist')
  expect(line).not.toContain('')
  expect(line).not.toContain('')
  expect(line).not.toContain('\n')
  warn.mockRestore()
})
