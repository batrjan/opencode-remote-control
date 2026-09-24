import { afterEach, beforeAll, expect, test } from 'vitest'
import { execFileSync, spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'

/**
 * The relay is ONE process serving EVERY tenant's share, so nothing that
 * happens on one socket may end it.
 *
 * These are black-box tests against the real entrypoint (dist/index.js, what
 * the Docker CMD runs), because the thing under test is the process itself:
 * in-process tests cannot see it, since vitest installs its own
 * uncaughtException handler and turns the death into a test report.
 *
 * What they pin: a hostile frame costs its own share at most, a stray throw or
 * rejection anywhere costs the request it happened in — and a relay that
 * cannot serve still dies rather than lingering as a port that answers nothing.
 */

const RELAY = fileURLToPath(new URL('..', import.meta.url))
const ENTRY = fileURLToPath(new URL('../dist/index.js', import.meta.url))

const TSC = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))

beforeAll(() => {
  // The entrypoint only exists compiled; this is `npm run build`.
  execFileSync(process.execPath, [TSC, '-p', 'tsconfig.json'], { cwd: RELAY, stdio: 'pipe' })
}, 120_000)

interface Relay {
  child: ChildProcessByStdio<null, Readable, Readable>
  port: number
  exit: { code: number | null; signal: string | null } | null
  stderr: () => string
}

const running: Relay[] = []

afterEach(() => {
  for (const relay of running.splice(0)) {
    try {
      relay.child.kill('SIGKILL')
    } catch {
      // already gone
    }
  }
})

/** A port nobody is listening on right now. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo
      probe.close(() => resolve(port))
    })
  })
}

/**
 * Start the real entrypoint. `script` replaces `node dist/index.js` with an
 * ES module that imports it and then misbehaves — the only way to raise a
 * stray error inside the relay process without a test hook in the shipped code.
 */
function spawnRelay(port: number, script?: string): Relay {
  const args = script ? ['--input-type=module', '-e', script] : [ENTRY]
  const child = spawn(process.execPath, args, {
    cwd: RELAY,
    env: { ...process.env, PORT: String(port), RELAY_STATE_FILE: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const relay: Relay = { child, port, exit: null, stderr: () => stderr }
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk)
  })
  child.stdout.resume()
  child.on('exit', (code, signal) => {
    relay.exit = { code, signal }
  })
  running.push(relay)
  return relay
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function health(relay: Relay): Promise<number | null> {
  try {
    return (await fetch(`http://127.0.0.1:${relay.port}/health`)).status
  } catch {
    return null
  }
}

/** Wait for the relay to answer, or give up — a dead one never will. */
async function started(relay: Relay): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    if ((await health(relay)) === 200) return true
    if (relay.exit) return false
    await sleep(50)
  }
  return false
}

/** Registration is public: this is what any visitor can do. */
async function register(relay: Relay, session_id: string): Promise<{ session_id: string; bridge_token: string }> {
  const res = await fetch(`http://127.0.0.1:${relay.port}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id, directory: '/work', title: 'share' }),
  })
  expect(res.status).toBe(201)
  return (await res.json()) as { session_id: string; bridge_token: string }
}

/** The public presence view — how a neighbour's share is checked from outside. */
async function bridgeConnected(relay: Relay, session_id: string): Promise<boolean> {
  const res = await fetch(`http://127.0.0.1:${relay.port}/api/sessions/${session_id}`)
  return ((await res.json()) as { bridge_connected: boolean }).bridge_connected
}

function openBridge(relay: Relay, session: { session_id: string; bridge_token: string }): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${relay.port}/bridge?session_id=${encodeURIComponent(session.session_id)}`,
      { headers: { 'x-bridge-token': session.bridge_token } },
    )
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

test('a bare `null` frame from one bridge does not end the relay or the neighbour share', async () => {
  const relay = spawnRelay(await freePort())
  expect(await started(relay)).toBe(true)

  const victim = await register(relay, `ses_${'V'.repeat(20)}`)
  const attacker = await register(relay, `ses_${'A'.repeat(20)}`)
  const victimSocket = await openBridge(relay, victim)
  let victimClosed = false
  victimSocket.on('close', () => {
    victimClosed = true
  })
  victimSocket.on('error', () => {})
  const attackerSocket = await openBridge(relay, attacker)
  attackerSocket.on('error', () => {})

  // Four bytes. JSON.parse('null') succeeds and yields null, and the next line
  // reads a property off it inside the synchronous ws 'message' handler.
  attackerSocket.send('null')
  await sleep(400)

  expect(relay.exit, `relay stderr:\n${relay.stderr()}`).toBeNull()
  expect(await health(relay)).toBe(200)
  expect(victimClosed).toBe(false)
  expect(await bridgeConnected(relay, victim.session_id)).toBe(true)
  // And the hub still takes new bridges: the frame cost nobody their share.
  const late = await register(relay, `ses_${'L'.repeat(20)}`)
  const lateSocket = await openBridge(relay, late)
  expect(await bridgeConnected(relay, late.session_id)).toBe(true)
  lateSocket.close()
}, 30_000)

test('other non-object JSON frames are ignored the same way', async () => {
  const relay = spawnRelay(await freePort())
  expect(await started(relay)).toBe(true)
  const attacker = await register(relay, `ses_${'P'.repeat(20)}`)

  for (const frame of ['null', '123', '"x"', 'true', '[]', '[null]', 'not json at all']) {
    const socket = await openBridge(relay, attacker)
    socket.on('error', () => {})
    socket.send(frame)
    await sleep(120)
    expect(relay.exit, `frame ${frame} killed the relay:\n${relay.stderr()}`).toBeNull()
    expect(await health(relay)).toBe(200)
    socket.close()
  }
}, 30_000)

test('a stray throw from a callback is logged, not fatal', async () => {
  const port = await freePort()
  const relay = spawnRelay(
    port,
    `await import(${JSON.stringify(ENTRY)}); setTimeout(() => { throw new Error('stray callback') }, 150)`,
  )
  expect(await started(relay)).toBe(true)
  await sleep(500)

  expect(relay.exit).toBeNull()
  expect(await health(relay)).toBe(200)
  expect(relay.stderr()).toContain('stray callback')
})

test('a stray unhandled rejection is logged, not fatal', async () => {
  const port = await freePort()
  const relay = spawnRelay(
    port,
    `await import(${JSON.stringify(ENTRY)}); setTimeout(() => { void Promise.reject(new Error('stray rejection')) }, 150)`,
  )
  expect(await started(relay)).toBe(true)
  await sleep(500)

  expect(relay.exit).toBeNull()
  expect(await health(relay)).toBe(200)
  expect(relay.stderr()).toContain('stray rejection')
})

test('a thrown value that cannot be printed does not take the handler down with it', async () => {
  // `String(Object.create(null))` throws: a last-resort handler that formats
  // its argument carelessly turns a survivable error into a fatal one.
  const port = await freePort()
  const relay = spawnRelay(
    port,
    `await import(${JSON.stringify(ENTRY)}); setTimeout(() => { throw Object.create(null) }, 150)`,
  )
  expect(await started(relay)).toBe(true)
  await sleep(500)

  expect(relay.exit).toBeNull()
  expect(await health(relay)).toBe(200)
})

/**
 * Surviving an error that escaped its call stack is the right call — one
 * process serves every tenant, and a restart would end every live share over a
 * bug that cost one request. But a survivable error is still a bug, and until
 * now nothing outside the container could tell one had happened: /health said
 * healthy, and the Docker HEALTHCHECK reads exactly that, so the only trace was
 * a line in a log that rotates.
 *
 * So the relay counts what it swallowed and says so in the body that every
 * uptime monitor already reads — WITHOUT turning the probe red, which would
 * trade one bug for the outage this handler exists to prevent.
 */
async function healthBody(relay: Relay): Promise<{ healthy?: boolean; faults?: { swallowed?: number; last_at?: number } }> {
  const res = await fetch(`http://127.0.0.1:${relay.port}/health`)
  expect(res.status).toBe(200)
  return (await res.json()) as { healthy?: boolean; faults?: { swallowed?: number } }
}

test('a swallowed error is visible to an operator, not only in the log', async () => {
  const port = await freePort()
  const relay = spawnRelay(
    port,
    `await import(${JSON.stringify(ENTRY)}); setTimeout(() => { void Promise.reject(new Error('stray rejection')) }, 150)`,
  )
  expect(await started(relay)).toBe(true)

  // Before anything went wrong the count is there and it is zero, so a monitor
  // can tell "nothing happened" from "this relay is too old to say".
  const clean = await healthBody(relay)
  expect(clean.faults?.swallowed).toBe(0)
  expect(clean.faults?.last_at).toBeUndefined()

  await sleep(500)
  expect(relay.exit, `relay stderr:\n${relay.stderr()}`).toBeNull()
  const after = await healthBody(relay)
  // Still healthy: a survivable error must not restart every live share.
  expect(after.healthy).toBe(true)
  expect(after.faults?.swallowed, 'nothing outside the log says an error was swallowed').toBeGreaterThan(0)
  expect(after.faults?.last_at).toBeTypeOf('number')
})

test('SIGTERM still ends the process', async () => {
  // The other side of surviving errors: a relay that swallows them must not
  // swallow its own shutdown — a redeploy waits on this exit.
  const relay = spawnRelay(await freePort())
  expect(await started(relay)).toBe(true)

  relay.child.kill('SIGTERM')
  for (let i = 0; i < 100 && !relay.exit; i++) await sleep(50)
  expect(relay.exit).not.toBeNull()
}, 20_000)

test('a relay that cannot take the port still dies', async () => {
  // The fatal state a restart is the only cure for: nothing this process can
  // catch should leave it up, listening to nobody, while its supervisor waits.
  const port = await freePort()
  const first = spawnRelay(port)
  expect(await started(first)).toBe(true)

  const second = spawnRelay(port)
  for (let i = 0; i < 100 && !second.exit; i++) await sleep(50)
  expect(second.exit, `second relay stderr:\n${second.stderr()}`).not.toBeNull()
  expect(second.exit?.code).not.toBe(0)
}, 20_000)
