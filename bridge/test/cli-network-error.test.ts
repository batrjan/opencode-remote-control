import { afterAll, beforeAll, expect, test } from 'vitest'
import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import { startServer } from '../../relay/src/server'
// @ts-expect-error — the TUI plugin is plain ESM JavaScript, no types.
import { parseBridgeLog } from '../../plugin/bridge-runner.js'
import { opencodeAuthHeader } from '../src/config'
import { describeError, fetchFrom } from '../src/errors'

/**
 * A network failure has to tell the owner which server failed, and why.
 *
 * Node's fetch throws the same TypeError('fetch failed') for every
 * connection-level failure — refused, a mistyped host, a reset, a certificate
 * it does not trust — and keeps the actual reason on `err.cause`. The CLI
 * printed only the top-level message, and none of the calls said which server
 * they were for, so a mistyped relay, a corporate CA and a dead local opencode
 * all reached the owner as "bridge start failed: fetch failed" — in the TUI
 * toast too, which shows that line as it is. Nothing in it said whether to look
 * at the relay URL, the network or the opencode on this machine.
 *
 * The message names the server (the relay, or the local opencode) by its
 * origin, carries the cause, and stays on ONE line: the plugin keeps only the
 * first line that matches its failure pattern.
 */

const BUNDLE = fileURLToPath(new URL('../../plugin/bridge/remote-control-bridge.cjs', import.meta.url))

let root: string
let fakeBin: string
let relay: Server
let relayUrl: string
let opencode: Server
let opencodePort: number

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'rc-cli-network-'))
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
    const url = new URL(req.url ?? '', 'http://localhost')
    if (url.pathname === '/session') return send(200, [{ id: 'ses_cli_network', directory: root, time: { created: 1 } }])
    send(404, { error: 'not found' })
  })
  await new Promise<void>((resolve) => opencode.listen(0, '127.0.0.1', resolve))
  opencodePort = (opencode.address() as AddressInfo).port
  relay = await startServer(0)
  relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise((resolve) => opencode.close(resolve))
  relay.closeAllConnections?.()
  await new Promise((resolve) => relay.close(resolve))
  rmSync(root, { recursive: true, force: true })
})

/** A port nothing listens on: bound and released again. */
async function closedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise((resolve) => server.close(resolve))
  return port
}

/** Run the committed bundle the way the plugin does, in a private HOME. */
async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const home = mkdtempSync(path.join(root, 'home-'))
  return await runCliIn(home, args)
}

function runCliIn(home: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BUNDLE, ...args],
      {
        cwd: root,
        env: { ...process.env, HOME: home, PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}` },
        timeout: 15_000,
      },
      (err, stdout, stderr) =>
        resolve({
          code: err ? Number((err as { code?: unknown }).code ?? 1) : 0,
          stdout: String(stdout).trim(),
          stderr: String(stderr).trim(),
        }),
    )
  })
}

test('start with no local opencode names the opencode server and the cause, not the relay', async () => {
  const deadOpencode = await closedPort()
  const deadRelay = await closedPort()
  const { code, stderr } = await runCli([
    'start',
    '--relay',
    `http://127.0.0.1:${deadRelay}`,
    '--port',
    String(deadOpencode),
  ])
  expect(code).toBe(1)
  expect(stderr.split('\n')).toHaveLength(1)
  expect(stderr).toMatch(
    new RegExp(`^bridge start failed: local opencode server http://127\\.0\\.0\\.1:${deadOpencode} unreachable: `),
  )
  expect(stderr).toContain(`ECONNREFUSED 127.0.0.1:${deadOpencode}`)
  expect(stderr).not.toMatch(/relay/)
})

test('start with an unreachable relay names the relay and the cause, and the plugin keeps all of it', async () => {
  const deadRelay = await closedPort()
  const { code, stderr } = await runCli([
    'start',
    '--relay',
    `http://127.0.0.1:${deadRelay}`,
    '--port',
    String(opencodePort),
  ])
  expect(code).toBe(1)
  expect(stderr.split('\n')).toHaveLength(1)
  expect(stderr).toMatch(new RegExp(`^bridge start failed: relay http://127\\.0\\.0\\.1:${deadRelay} unreachable: `))
  expect(stderr).toContain(`ECONNREFUSED 127.0.0.1:${deadRelay}`)
  // The toast the TUI shows for a failed start is this line, whole.
  expect(parseBridgeLog(stderr).failure).toBe(stderr)
})

test('start whose opencode event stream cannot be opened names the opencode server', async () => {
  // With an explicit session id the session lookup is best effort, so the
  // relay registration and the bridge WebSocket go through and the first call
  // that fails is the subscription to opencode's /event stream.
  const deadOpencode = await closedPort()
  const { code, stderr } = await runCli([
    'start',
    '--relay',
    relayUrl,
    '--port',
    String(deadOpencode),
    '--session-id',
    'ses_cli_network_events',
  ])
  expect(code).toBe(1)
  expect(stderr.split('\n')).toHaveLength(1)
  expect(stderr).toMatch(
    new RegExp(`^bridge start failed: local opencode server http://127\\.0\\.0\\.1:${deadOpencode} unreachable: `),
  )
  expect(stderr).toContain('ECONNREFUSED')
})

test('stop with an unreachable relay names the relay and the cause in its warning', async () => {
  const home = mkdtempSync(path.join(root, 'home-'))
  const stateDir = path.join(home, '.agents', 'skills', 'remote-control', 'state')
  mkdirSync(stateDir, { recursive: true })
  const deadRelay = await closedPort()
  writeFileSync(
    path.join(stateDir, 'ses_cli_network_stop.json'),
    JSON.stringify({
      session_id: 'ses_cli_network_stop',
      access_code: 'XXXXXX',
      bridge_token: 'token-the-relay-never-sees',
      // The share's own relay: `stop` sends its token nowhere else.
      relay: `http://127.0.0.1:${deadRelay}`,
      started_at: Date.now(),
    }),
  )
  const { code, stdout } = await runCliIn(home, [
    'stop',
    '--relay',
    `http://127.0.0.1:${deadRelay}`,
    '--session-id',
    'ses_cli_network_stop',
  ])
  // The share ends locally either way (see stop-teardown.test.ts); the warning
  // is what says why the relay was not told.
  expect(code).toBe(0)
  expect(stdout.split('\n')).toHaveLength(1)
  expect(stdout).toMatch(/relay could not be told/)
  expect(stdout).toContain(`relay http://127.0.0.1:${deadRelay} unreachable`)
  expect(stdout).toContain(`ECONNREFUSED 127.0.0.1:${deadRelay}`)
})

test('status with an unreachable relay says why', async () => {
  const deadRelay = await closedPort()
  const { code, stdout } = await runCli(['status', '--relay', `http://127.0.0.1:${deadRelay}`])
  expect(code).toBe(1)
  const relayLine = stdout.split('\n').find((line) => line.startsWith('relay:'))
  expect(relayLine).toContain(`unreachable (http://127.0.0.1:${deadRelay})`)
  expect(relayLine).toContain(`ECONNREFUSED 127.0.0.1:${deadRelay}`)
})

/* ------------------------------ the formatter ------------------------------ */

/** What fetch throws for a connection-level failure, built by hand. */
function fetchFailed(cause: unknown): TypeError {
  return new TypeError('fetch failed', { cause })
}

test('a fetch failure is described with its cause, on one line', () => {
  const err = fetchFailed(Object.assign(new Error('getaddrinfo ENOTFOUND x.invalid'), { code: 'ENOTFOUND' }))
  expect(describeError(err)).toBe('fetch failed (getaddrinfo ENOTFOUND x.invalid)')
  // A code the message does not already name goes in front of it, and a
  // message spread over lines is put on one.
  const tls = fetchFailed(
    Object.assign(new Error('self-signed certificate\nin certificate chain'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' }),
  )
  expect(describeError(tls)).toBe(
    'fetch failed (SELF_SIGNED_CERT_IN_CHAIN: self-signed certificate in certificate chain)',
  )
})

test('a connect to every address of a name is described by each address', () => {
  // localhost resolves to ::1 and 127.0.0.1: the cause is an AggregateError
  // whose own message is empty.
  const refused = (address: string) =>
    Object.assign(new Error(`connect ECONNREFUSED ${address}`), { code: 'ECONNREFUSED' })
  const aggregate = Object.assign(new AggregateError([refused('::1:4096'), refused('127.0.0.1:4096')], ''), {
    code: 'ECONNREFUSED',
  })
  expect(describeError(fetchFailed(aggregate))).toBe(
    'fetch failed (connect ECONNREFUSED ::1:4096, connect ECONNREFUSED 127.0.0.1:4096)',
  )
})

test('a cause already quoted is not repeated, and a cycle ends the walk', () => {
  const inner = fetchFailed(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))
  const wrapped = new Error(`relay https://relay.example unreachable: ${describeError(inner)}`, { cause: inner })
  expect(describeError(wrapped)).toBe('relay https://relay.example unreachable: fetch failed (read ECONNRESET)')
  const a = new Error('a')
  const b = new Error('b', { cause: a })
  ;(a as { cause?: unknown }).cause = b
  expect(describeError(a)).toBe('a (b)')
  expect(describeError('plain text')).toBe('plain text')
})

test('credentials in a quoted URL are dropped', () => {
  const err = new TypeError(
    'Request cannot be constructed from a URL that includes credentials: https://me:secret@relay.example/api/sessions',
  )
  expect(describeError(err)).toBe(
    'Request cannot be constructed from a URL that includes credentials: https://relay.example/api/sessions',
  )
})

test('fetchFrom names the server by its origin only, and leaves timeouts alone', async () => {
  const dead = await closedPort()
  // fetch refuses a URL with credentials before it connects, and quotes the URL
  // in its message: the relay is still named by its origin, and the
  // credentials appear nowhere in what the owner is shown.
  const failure = await fetchFrom('relay', `http://owner:hunter2@127.0.0.1:${dead}/api/sessions`).catch(
    (err: Error) => err,
  )
  expect((failure as Error).message).toMatch(new RegExp(`^relay http://127\\.0\\.0\\.1:${dead} unreachable: `))
  expect((failure as Error).message).not.toContain('hunter2')
  expect(describeError(failure)).not.toContain('hunter2')
  const refused = await fetchFrom('relay', `http://127.0.0.1:${dead}/api/sessions`).catch((err: Error) => err)
  expect(describeError(refused)).toBe(
    `relay http://127.0.0.1:${dead} unreachable: fetch failed (connect ECONNREFUSED 127.0.0.1:${dead})`,
  )
  const hang = createServer(() => {})
  await new Promise<void>((resolve) => hang.listen(0, '127.0.0.1', resolve))
  try {
    const timedOut = await fetchFrom('relay', `http://127.0.0.1:${(hang.address() as AddressInfo).port}/`, {
      signal: AbortSignal.timeout(50),
    }).catch((err: Error) => err)
    expect((timedOut as Error).name).toBe('TimeoutError')
  } finally {
    hang.closeAllConnections()
    await new Promise((resolve) => hang.close(resolve))
  }
})
