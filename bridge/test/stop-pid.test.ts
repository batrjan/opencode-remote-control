import { afterEach, expect, test, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { terminateBridgeProcess, type ProcessSnapshot, terminateSpawnedServer } from '../src/index'

/**
 * `stop` reads a pid out of a state file that outlives a bridge killed with
 * -9, a panic or a reboot — and the OS recycles pids. Sending SIGTERM to
 * whatever now owns that number kills a stranger's process (a shell, an
 * editor, someone else's build). Every signal must therefore be preceded by
 * proof that the pid still runs a bridge.
 */

const children: ChildProcess[] = []

/** A process that stays alive until signalled — the innocent bystander. */
function spawnBystander(): ChildProcess {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)"], {
    stdio: 'ignore',
  })
  children.push(child)
  return child
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForExit(child: ChildProcess, timeoutMs = 2000): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true
  return await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

/** A command line as `ps` reports it for a really installed bridge. */
const BRIDGE_COMMAND = `${process.execPath} /Users/me/.agents/skills/remote-control/bin/index.js start --relay https://opencode.b4tr.net`

afterEach(() => {
  vi.restoreAllMocks()
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
})

test('does not signal a pid whose real command line is not a bridge', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const bystander = spawnBystander()
  // Give the child a moment to be visible to `ps`.
  await wait(200)
  expect(alive(bystander.pid!)).toBe(true)

  // No injection here: this exercises the real `ps` lookup on this OS.
  terminateBridgeProcess(bystander.pid!, Date.now())

  await wait(300)
  expect(bystander.exitCode).toBeNull()
  expect(bystander.signalCode).toBeNull()
  expect(alive(bystander.pid!)).toBe(true)
  expect(warn).toHaveBeenCalledWith(expect.stringContaining(`not signalling pid ${bystander.pid}`))
})

test('still signals a pid that really is running the bridge', async () => {
  const child = spawnBystander()
  await wait(100)
  terminateBridgeProcess(child.pid!, Date.now(), () => ({ command: BRIDGE_COMMAND, startedAt: Date.now() - 5_000 }))
  expect(await waitForExit(child)).toBe(true)
  expect(alive(child.pid!)).toBe(false)
})

test('accepts every shape of bridge command line the launchers produce', () => {
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
  const node = process.execPath
  const commands = [
    `${node} /Users/me/.agents/skills/remote-control/bin/index.js start --relay https://r`,
    `${node} /Users/me/.opencode/plugin/bridge/remote-control-bridge.cjs start --relay https://r`,
    `${node} /Users/me/code/opencode-remote-control/bridge/dist/index.js start`,
    `${node} /Users/me/code/opencode-remote-control/node_modules/.bin/bridge start`,
  ]
  for (const command of commands) {
    kill.mockClear()
    terminateBridgeProcess(4242, undefined, () => ({ command }))
    expect(kill, command).toHaveBeenCalledWith(4242, 'SIGTERM')
  }
  // …and refuses the things a recycled pid actually turns into.
  for (const command of [`${node} /Users/me/code/other-app/server.js`, '/bin/zsh -l', 'ssh-agent -s']) {
    kill.mockClear()
    terminateBridgeProcess(4242, undefined, () => ({ command }))
    expect(kill, command).not.toHaveBeenCalled()
  }
})

test('refuses a pid whose process started after the share was registered', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const bystander = spawnBystander()
  await wait(100)
  const startedAt = Date.now()
  // A bridge-looking command line is not enough: this process appeared long
  // after `start` wrote the state file, so the pid was recycled.
  terminateBridgeProcess(bystander.pid!, startedAt, () => ({
    command: BRIDGE_COMMAND,
    startedAt: startedAt + 10 * 60_000,
  }))
  await wait(200)
  expect(alive(bystander.pid!)).toBe(true)
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('recycled pid'))

  // The bridge's own start time PRECEDES started_at (the state file is written
  // after registration), so that case must still be signalled.
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
  terminateBridgeProcess(4243, startedAt, () => ({ command: BRIDGE_COMMAND, startedAt: startedAt - 3_000 }))
  expect(kill).toHaveBeenCalledWith(4243, 'SIGTERM')
})

test('never throws and never signals the caller', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
  // Own pid: the library path runs stop inside the bridge process.
  expect(() => terminateBridgeProcess(process.pid, Date.now())).not.toThrow()
  expect(() => terminateBridgeProcess(undefined, Date.now())).not.toThrow()
  // A lookup that blows up (no `ps`, sandbox, EPERM) must neither throw nor
  // fall through to a blind kill.
  expect(() =>
    terminateBridgeProcess(4244, Date.now(), () => {
      throw new Error('ps unavailable')
    }),
  ).not.toThrow()
  // A pid nothing is running any more.
  expect(() => terminateBridgeProcess(4245, Date.now(), () => null)).not.toThrow()
  expect(kill).not.toHaveBeenCalled()
})

test('a snapshot without a start time is judged on the command line alone', () => {
  // `ps` builds that do not know `lstart` still give us the command; losing
  // the corroborating start time must not lose the ability to stop.
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
  const snapshot: ProcessSnapshot = { command: BRIDGE_COMMAND }
  terminateBridgeProcess(4246, Date.now(), () => snapshot)
  expect(kill).toHaveBeenCalledWith(4246, 'SIGTERM')
})

/**
 * The orphan a SIGKILL leaves behind.
 *
 * The bridge spawns `opencode serve` when nothing is listening (the TUI has no
 * HTTP port) and kills it on the way out — but only along paths that run
 * JavaScript. `kill -9`, a panic or a reboot skip all of them, and the server
 * then runs forever holding its port; the NEXT `start` detects that stale
 * server and attaches to it, binding a new share to a server left over from an
 * old one. Verified against the real thing before this existed: after killing
 * the bridge with -9, `stop` cleaned the relay session and the state file while
 * the spawned server kept listening on 4096.
 */
test('stop terminates the opencode server the bridge spawned', () => {
  const signalled: number[] = []
  const realKill = process.kill.bind(process)
  const spy = ((pid: number, sig?: string | number) => {
    signalled.push(pid)
    return true
  }) as typeof process.kill
  process.kill = spy
  try {
    terminateSpawnedServer(4242, Date.now(), () => ({
      command: '/Users/me/.opencode/bin/opencode serve --hostname 127.0.0.1',
      startedAt: Date.now() - 60_000,
    }))
  } finally {
    process.kill = realKill
  }
  expect(signalled).toEqual([4242])
})

test('stop does not terminate a pid that is no longer an opencode server', () => {
  const signalled: number[] = []
  const realKill = process.kill.bind(process)
  process.kill = ((pid: number) => {
    signalled.push(pid)
    return true
  }) as typeof process.kill
  try {
    for (const command of [
      '/usr/bin/node /Users/me/code/other-app/server.js',
      '/bin/zsh -l',
      'opencode', // the TUI, not a server the bridge started
      '/opt/homebrew/bin/opencodex serve',
    ]) {
      terminateSpawnedServer(4242, Date.now(), () => ({ command, startedAt: Date.now() - 60_000 }))
    }
    // A pid that is simply gone, and our own pid.
    terminateSpawnedServer(4242, Date.now(), () => null)
    terminateSpawnedServer(process.pid, Date.now(), () => ({ command: 'opencode serve' }))
  } finally {
    process.kill = realKill
  }
  expect(signalled).toEqual([])
})

test('stop does not terminate a server that started after the share was registered', () => {
  const signalled: number[] = []
  const realKill = process.kill.bind(process)
  process.kill = ((pid: number) => {
    signalled.push(pid)
    return true
  }) as typeof process.kill
  try {
    const shareRegisteredAt = Date.now() - 3_600_000
    terminateSpawnedServer(4242, shareRegisteredAt, () => ({
      command: '/usr/local/bin/opencode serve --hostname 127.0.0.1',
      startedAt: Date.now(), // a fresh process wearing a recycled pid
    }))
  } finally {
    process.kill = realKill
  }
  expect(signalled).toEqual([])
})
