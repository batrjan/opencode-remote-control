import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * A slow start used to be reported as failed while it went on to succeed.
 *
 * The plugin spawns the bridge detached and gave it 30 s to print the share URL
 * and code. When the time ran out it only rejected: the bridge kept running,
 * registered the share and printed a code the plugin had stopped reading, so
 * the owner saw "timeout waiting for the bridge" next to a live share with a
 * spawned `opencode serve` behind it. 30 s is short for that path: detection,
 * a cold `opencode serve` (up to 20 s to report a port, then a health poll),
 * the relay registration and the bridge WebSocket, all over an uplink measured
 * at 0.7-1.7 Mbit/s. Reproduced locally with every stage inside its own limit
 * (17 s port, 8 s registration, 7 s upgrade): rejected at 30 s, code logged 6 s
 * later, a viewer activated it. A retry then hit 409 and its `openLog` truncated
 * the only copy of that code.
 *
 * The plugin now waits two minutes, and when that runs out it cancels for real:
 * the bridge's whole process group (the bridge and the server it spawned) is
 * signalled, and a share that bridge had already registered is stopped.
 *
 * child_process is mocked, so nothing is spawned and no relay is contacted; the
 * fake bridge carries a pid no real process group can have.
 */
const fake = vi.hoisted(() => ({
  /** Larger than any pid_max, so even an unmocked kill could not reach a real group. */
  pid: 2_000_000_001,
  child: undefined as undefined | (import('node:events').EventEmitter & { pid: number; unref: () => void; kill: (s?: string) => boolean }),
  /** The fd the plugin handed the bridge for its output. */
  stdout: undefined as number | undefined,
  execCalls: [] as string[][],
}))

vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    spawn: vi.fn((_command: string, _args: string[], opts: { stdio: [unknown, number, number] }) => {
      const child = Object.assign(new EventEmitter(), { pid: fake.pid, unref: vi.fn(), kill: vi.fn(() => true) })
      fake.child = child
      fake.stdout = opts.stdio[1]
      return child
    }),
    execFile: vi.fn((_file: string, args: string[], _opts: unknown, cb: (e: Error | null, o: string, s: string) => void) => {
      fake.execCalls.push(args)
      cb(null, 'Remote control stopped.', '')
    }),
  }
})

// @ts-expect-error — the plugin is plain ESM JavaScript, no types.
import { logPath, runAction } from '../../plugin/bridge-runner.js'

const FAKE_PID = fake.pid
const DEADLINE_MS = 2 * 60_000

let home: string
const saved = { HOME: process.env.HOME, TIMEOUT: process.env.REMOTE_CONTROL_START_TIMEOUT_MS }
let kill: ReturnType<typeof vi.spyOn>
/** Pids process.kill was aimed at, in order (negative = a process group). */
let signalled: number[]

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'rc-start-timeout-'))
  process.env.HOME = home
  // The two-minute default, whatever the environment running the tests says.
  delete process.env.REMOTE_CONTROL_START_TIMEOUT_MS
  fake.child = undefined
  fake.execCalls.length = 0
  signalled = []
  kill = vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
    signalled.push(pid)
    // A SIGTERM'd group dies: the bridge installs no handler before it is up.
    if (Math.abs(pid) === FAKE_PID) fake.child?.emit('exit', null, 'SIGTERM')
    return true
  }) as typeof process.kill)
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  kill.mockRestore()
  if (saved.HOME === undefined) delete process.env.HOME
  else process.env.HOME = saved.HOME
  if (saved.TIMEOUT !== undefined) process.env.REMOTE_CONTROL_START_TIMEOUT_MS = saved.TIMEOUT
  rmSync(home, { recursive: true, force: true })
})

function stateFile(sessionId: string, pid: number) {
  const dir = path.dirname(logPath())
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(
    path.join(dir, `${sessionId}.json`),
    JSON.stringify({ session_id: sessionId, access_code: 'X', bridge_token: 't', relay: '', started_at: Date.now(), pid }),
    { mode: 0o600 },
  )
}

/** Start through the plugin and keep the outcome inspectable without awaiting it. */
function start(sessionId: string) {
  const outcome: { value?: string; error?: Error } = {}
  const done = runAction('start', sessionId).then(
    (value: string) => (outcome.value = value),
    (error: Error) => (outcome.error = error),
  )
  return { outcome, done }
}

test('a start still coming up after 30 s delivers its code', async () => {
  const { outcome, done } = start('ses_slow')
  await vi.advanceTimersByTimeAsync(45_000)
  expect(outcome.error?.message).toBeUndefined()
  writeSync(fake.stdout!, 'http://relay.local/ses_slow\nCODE: LATE00\n')
  await vi.advanceTimersByTimeAsync(1_000)
  await done
  expect(outcome.value).toBe('http://relay.local/ses_slow\nCODE: LATE00')
  // A start that came up publishes its log as bridge.log.
  expect(readFileSync(logPath(), 'utf8')).toBe('http://relay.local/ses_slow\nCODE: LATE00\n')
  expect(signalled).toEqual([])
})

test('a start that never comes up is cancelled with the server it spawned', async () => {
  const { outcome, done } = start('ses_stuck')
  await vi.advanceTimersByTimeAsync(DEADLINE_MS + 5_000)
  await done
  // The whole detached group, so the `opencode serve` child goes too — a pid
  // SIGTERM killed the bridge and left its server re-parented to init.
  expect(signalled, 'the timed-out bridge was never signalled').toContain(-FAKE_PID)
  expect(outcome.error?.message).toMatch(/cancelled/)
  // Nothing was registered, so there is nothing to stop.
  expect(fake.execCalls).toEqual([])
})

test('a share the cancelled bridge already registered is stopped', async () => {
  const { outcome, done } = start('ses_registered')
  await vi.advanceTimersByTimeAsync(60_000)
  // Registered with the relay, still stuck on the WebSocket or the event stream.
  stateFile('ses_registered', FAKE_PID)
  await vi.advanceTimersByTimeAsync(DEADLINE_MS)
  await done
  expect(outcome.error?.message).toMatch(/cancelled/)
  expect(fake.execCalls).toHaveLength(1)
  expect(fake.execCalls[0]).toEqual(expect.arrayContaining(['stop', '--session-id', 'ses_registered']))
})

test('another bridge sharing the same session is left alone', async () => {
  // A live share of this session from an earlier start: its state names its own pid.
  stateFile('ses_shared', 4242)
  const { outcome, done } = start('ses_shared')
  await vi.advanceTimersByTimeAsync(DEADLINE_MS + 5_000)
  await done
  expect(outcome.error?.message).toMatch(/cancelled/)
  expect(fake.execCalls).toEqual([])
  expect(signalled.every((pid) => Math.abs(pid) === FAKE_PID)).toBe(true)
})

test('falls back to the bridge pid where process groups cannot be signalled', async () => {
  kill.mockImplementation((() => {
    throw Object.assign(new Error('kill EINVAL'), { code: 'EINVAL' })
  }) as typeof process.kill)
  const { outcome, done } = start('ses_windows')
  await vi.advanceTimersByTimeAsync(DEADLINE_MS + 5_000)
  await done
  expect(outcome.error?.message).toMatch(/cancelled/)
  expect(fake.child?.kill).toHaveBeenCalledWith('SIGTERM')
})
