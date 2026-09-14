import { expect, test } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Whether an owner who runs a remote-control command through `opencode run`
 * gets to see what it did.
 *
 * README.md tells owners to end or check a share from a terminal with
 * `opencode run --session <id> --command remote-control/stop` (or `…/status`).
 * The server entry puts the action's output into the command's user message
 * and tells the model to answer with exactly "OK". `opencode run` (1.18.30,
 * Cli.run) prints only text parts that are finished (`time.end`): the model's
 * reply has one, the user message does not. So all the terminal ever showed
 * was "OK", exit 0 — the same for a stop that ended the share, one that found
 * nothing to stop in that session, and "remote-control stop failed: …". An
 * owner who named the wrong session read "OK" and left the access code and the
 * viewer's shell live; the status line meant to check it printed "OK" too, and
 * `opencode run --command remote-control/start` never showed the URL and code.
 *
 * Each case runs the server entry's hook in a child process whose argv is laid
 * out like the opencode binary's (`<runtime> <entry> run …`), the way a real
 * `opencode run` loads the plugin in-process, and looks at what reaches the
 * terminal. The action is stubbed: nothing here spawns a bridge or reads state.
 */

const SERVER_ENTRY = new URL('../../plugin/server.js', import.meta.url).href
const README = fileURLToPath(new URL('../../README.md', import.meta.url))

/** Stand-in for the compiled binary's own entry, argv[1] of `opencode`. */
const OPENCODE_ENTRY = '/$bunfs/root/opencode'

/**
 * A minimal `opencode` process: reads --command/--session the way Cli.run
 * does, fires the server entry's command hook once, and exits. The action
 * answers with RC_OUTCOME.text, or throws RC_OUTCOME.error.
 */
const FAKE_OPENCODE = `
import { createHooks } from ${JSON.stringify(SERVER_ENTRY)}
// opencode run uses process.stderr for its own lines before any command runs,
// and touching it leaves a piped fd 2 non-blocking (Bun and Node alike).
void process.stderr.fd
const argv = process.argv.slice(2)
const value = (...flags) => {
  const i = argv.findIndex((a) => flags.includes(a))
  return i < 0 ? undefined : argv[i + 1]
}
const outcome = JSON.parse(process.env.RC_OUTCOME)
// \`opencode run --attach <url>\` (1.18.30) loads no plugin at all: it hands the
// command to that server, where the hook runs, and prints only the model's
// reply. So the hook decides as that server would, and nothing it shows reaches
// this terminal: the server's stderr is its own log.
const attached = value('--attach') !== undefined
if (attached) process.argv.splice(2, Infinity, 'serve')
const hooks = createHooks(async (action, sessionID) => {
  // Record every action the runner was asked for, so a test can tell an action
  // that ran from one the plugin declined without running.
  if (process.env.RC_CALLS) (await import('node:fs')).appendFileSync(process.env.RC_CALLS, action + '\\n')
  if (outcome.error) throw new Error(outcome.error)
  const text = outcome.text.repeat(outcome.times ?? 1) + (outcome.tail ?? '')
  return text.replaceAll('{action}', action).replaceAll('{session}', String(sessionID))
}, undefined, undefined, attached ? () => {} : undefined)
const output = { parts: [] }
await hooks['command.execute.before'](
  { command: value('--command') ?? 'remote-control/status', sessionID: value('--session', '-s') ?? 'ses_new', arguments: '' },
  output,
)
// The message itself is unchanged: the output is still its only visible part.
// A status of its own: a throw would exit 1, the status of a declined start.
if (output.parts.filter((p) => !p.synthetic).length !== 1) {
  process.stderr.write('message parts changed\\n')
  process.exit(70)
}
`

/** times/tail build a large output inside the child: an environment variable cannot carry it. */
type Outcome = { text?: string; error?: string; times?: number; tail?: string }

/**
 * Run the fake `opencode` and expect it to exit with `status`. `opencode run`
 * (1.18.30) exits with the process.exitCode the hook leaves, as a script's `&&`
 * sees it.
 */
function runOpencode(args: string[], outcome: Outcome, extraEnv: Record<string, string> = {}, status = 0) {
  // A throwaway HOME and no inherited OPENCODE_* variables: the test must not
  // depend on (or touch) the opencode this suite happens to run under.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-run-output-'))
  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', FAKE_OPENCODE, OPENCODE_ENTRY, ...args], {
      env: { PATH: process.env.PATH ?? '', HOME: home, RC_OUTCOME: JSON.stringify(outcome), ...extraEnv },
      encoding: 'utf8',
      timeout: 20_000,
    })
    expect(child.error, 'fake opencode ran').toBeUndefined()
    expect(child.status, `fake opencode ${args.join(' ')} exit status: ${child.stderr}`).toBe(status)
    return { stdout: child.stdout, stderr: child.stderr }
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
}

/** The words after `opencode` of every inline `opencode run …` in a text that names a remote-control command. */
function runLines(text: string): string[][] {
  return [...text.matchAll(/`(opencode run\b[^`]*)`/g)]
    .map((m) => m[1].replace(/\s+/g, ' ').trim())
    .filter((line) => line.includes('remote-control'))
    .map((line) =>
      line
        .split(' ')
        .slice(1)
        .map((w) => w.replace(/^["']|["']$/g, '')),
    )
}

const readmeRunLines = () => runLines(fs.readFileSync(README, 'utf8'))

/**
 * Where an owner who wants a share from a terminal is sent, in the decline text
 * or in README.md.
 *
 * It used to be `opencode run --attach <server-url> --session <id> --command
 * remote-control/start`. On opencode 1.18.30 that does start a share, in the
 * server, which keeps it — but the `run --attach` client loads no plugin and
 * prints only the model's "OK" (with `--format json` too), and the server writes
 * the output only into the session. The owner followed the advice, saw "OK" and
 * never learned the URL or code of a share that was live; a second start got a
 * 409 and "OK" again. `opencode attach <server-url>` draws the session, so the
 * start typed there shows both.
 */
function expectStartAdviceThatShowsTheCode(text: string, label: string) {
  // An `opencode run --attach` recipe for a start has to put the code on the
  // terminal. (A plain `opencode run` start is declined, as the first test shows.)
  for (const words of runLines(text).filter((w) => w.includes('--attach') && w.includes('remote-control/start'))) {
    const { stderr } = runOpencode(words, { text: 'https://relay.example/s/{session}\nCODE: TEST00' })
    expect(stderr, `${label}: ${words.join(' ')}`).toContain('CODE: TEST00')
  }
  const flat = text.replace(/\s+/g, ' ')
  expect(flat, label).toMatch(/`opencode attach <(server-)?url>/)
  expect(flat, label).toContain('/remote-control/start')
  // `opencode run --attach` may be named only together with what it hides.
  if (flat.includes('opencode run --attach')) expect(flat, label).toMatch(/only the model's `?OK`?/)
}

test("README's `opencode run` lines show the command's result on the terminal, not only the model's OK", () => {
  const lines = readmeRunLines()
  expect(lines.length, 'README shows how to run the commands from a terminal').toBeGreaterThan(0)
  for (const words of lines) {
    const action = words[words.indexOf('--command') + 1].split('/')[1]
    // A stop that finds nothing must not look like one that ended the share. A
    // plain `opencode run` start is declined, and exits 1 (see the decline test).
    const declined = action === 'start' && !words.includes('--attach')
    const { stdout, stderr } = runOpencode(
      words,
      { text: 'session {session} is not shared from this machine — nothing to {action}.\nShared from this machine: ses_other.' },
      {},
      declined ? 1 : 0,
    )
    if (action === 'start') {
      // A plain `opencode run` never starts a share; the line shows why and how.
      expect(stderr, words.join(' ')).toContain('does nothing in `opencode run`')
      expectStartAdviceThatShowsTheCode(stderr, words.join(' '))
    } else {
      expect(stderr, words.join(' ')).toContain(`is not shared from this machine — nothing to ${action}.`)
      expect(stderr, words.join(' ')).toContain('Shared from this machine: ses_other.')
    }
    // stdout is the model's reply (or the JSON event stream): left alone.
    expect(stdout, words.join(' ')).toBe('')
  }
  // The two recipes an owner is sent to from a session with no share are both
  // among the lines checked above, written out in full.
  expect(
    lines.map((words) => words[words.indexOf('--command') + 1]),
    'README gives a terminal stop and a terminal status',
  ).toEqual(expect.arrayContaining(['remote-control/stop', 'remote-control/status']))
})

/**
 * README.md sent a terminal owner to "point `opencode run --attach` at" a
 * running `opencode serve`. That code span names no remote-control command, so
 * the recipe check above never saw it, and the advice led to a live share whose
 * URL and code the terminal never showed (see expectStartAdviceThatShowsTheCode).
 */
test("README's advice for starting a share from a terminal leads to the URL and code", () => {
  const paragraphs = fs.readFileSync(README, 'utf8').split(/\n\s*\n/)
  const declined = paragraphs.filter((p) => /`opencode run [^`]*--command remote-control\/start`/.test(p.replace(/\s+/g, ' ')))
  expect(declined.length, 'README explains why `opencode run` starts no share').toBeGreaterThan(0)
  for (const p of declined) expectStartAdviceThatShowsTheCode(p, 'README: the declined start')
  for (const p of paragraphs.filter((p) => p.replace(/\s+/g, ' ').includes('opencode run --attach'))) {
    expect(p.replace(/\s+/g, ' '), 'README names `opencode run --attach` with what it hides').toMatch(/only the model's `OK`/)
  }
})

/** The fake's `--attach` behaves as measured on the real binary. */
test('opencode run --attach starts the share in the server and shows nothing of it here', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-run-calls-'))
  const calls = path.join(dir, 'calls')
  try {
    for (const format of [[], ['--format', 'json']]) {
      fs.rmSync(calls, { force: true })
      const { stdout, stderr } = runOpencode(
        ['run', ...format, '--attach', 'http://127.0.0.1:4096', '--session', 'ses_x', '--command', 'remote-control/start'],
        { text: 'https://relay.example/s/{session}\nCODE: TEST00' },
        { RC_CALLS: calls },
      )
      expect(fs.readFileSync(calls, 'utf8')).toBe('start\n')
      expect({ stdout, stderr }).toEqual({ stdout: '', stderr: '' })
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a failed action reaches the terminal too, also with --format json', () => {
  for (const format of [[], ['--format', 'json']]) {
    const { stdout, stderr } = runOpencode(
      ['run', ...format, '--session', 'ses_x', '--command', 'remote-control/stop'],
      { error: 'relay unreachable' },
    )
    expect(stderr).toContain('remote-control stop failed: relay unreachable')
    // Never on stdout: `--format json` consumers parse every line of it.
    expect(stdout).toBe('')
  }
})

/**
 * A share cannot be started from a plain `opencode run`.
 *
 * The bridge follows the OpenCode process that started the share (the plugin
 * passes its pid as --owner-pid) and ends the share when that process exits.
 * `opencode run` exits right after its one command, so the share it started
 * was gone within seconds — while the terminal had just printed its URL and
 * access code, which the owner then sent to a viewer who found a dead link.
 * The start is declined up front instead, with the ways that do keep a share
 * running and show its URL and code, and no bridge is spawned at all.
 *
 * The decline exits 1. It used to exit 0 with the model's "OK" on stdout, the
 * same as a start that worked, so `opencode run --command remote-control/start
 * 2>share.txt && send share.txt` sent a viewer the decline text instead of a
 * link and code.
 */
test('a start from opencode run is declined with a way that shows the URL and code, starts nothing, and exits 1', () => {
  const calls = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rc-run-calls-')), 'calls')
  for (const format of [[], ['--format', 'json']]) {
    fs.rmSync(calls, { force: true })
    const { stdout, stderr } = runOpencode(
      ['run', ...format, '--session', 'ses_x', '--command', 'remote-control/start'],
      { text: 'https://relay.example/s/{session}\nCODE: TEST00' },
      { RC_CALLS: calls },
      1,
    )
    expect(fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '', 'the runner was never asked to start').toBe('')
    expect(stderr).not.toContain('CODE: TEST00')
    expect(stderr).toContain('opencode run')
    expectStartAdviceThatShowsTheCode(stderr, `decline text (${format.join(' ') || 'plain'})`)
    expect(stdout).toBe('')
  }
  // The same command still starts a share in a process that stays: a server
  // (desktop sidecar, web, serve) and the TUI entry's host.
  for (const args of [['serve', '--port', '4096'], ['web'], []]) {
    fs.rmSync(calls, { force: true })
    runOpencode([...args, '--command', 'remote-control/start'], { text: 'https://relay.example/s/{session}\nCODE: TEST00' }, { RC_CALLS: calls })
    expect({ args, calls: fs.readFileSync(calls, 'utf8') }).toEqual({ args, calls: 'start\n' })
  }
})

/**
 * `opencode run` typed into a terminal that OpenCode itself opened.
 *
 * OPENCODE_CLIENT is inherited: the desktop app sets it to "desktop" in its own
 * environment, and every child — its sidecar server, the built-in terminal's
 * shell, a bash tool call — starts with that value. An owner who typed the
 * README's stop line into the desktop app's terminal therefore ran a plain
 * `opencode run` with OPENCODE_CLIENT=desktop, and the output was withheld as if
 * this were the desktop client itself: once more only the model's "OK". The
 * subcommand is what says this process prints nothing but the reply.
 */
test('a run typed into a terminal OpenCode opened still shows the result', () => {
  for (const client of ['desktop', 'acp', 'vscode']) {
    const { stdout, stderr } = runOpencode(
      ['run', '--session', 'ses_x', '--command', 'remote-control/stop'],
      { text: 'Remote control stopped.' },
      { OPENCODE_CLIENT: client },
    )
    expect({ client, stderr }).toEqual({ client, stderr: expect.stringContaining('Remote control stopped.') })
    expect(stdout).toBe('')
  }
})

/**
 * A caller that closed the stderr pipe must still get the real exit status.
 *
 * Scripts run `opencode run --format json … --command remote-control/stop` and
 * read only stdout; one that closes (or never drains) the stderr pipe made the
 * plugin's write fail with EPIPE. The failure arrives as an asynchronous
 * 'error' event on process.stderr, past the try/catch around the write, and the
 * process exited 1 — after the share had been stopped, so a `&& echo stopped`
 * concluded the stop failed.
 */
test('a closed stderr pipe does not turn a finished command into a failure', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-run-epipe-'))
  try {
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', FAKE_OPENCODE, OPENCODE_ENTRY, 'run', '--format', 'json', '--command', 'remote-control/stop'],
      {
        env: { PATH: process.env.PATH ?? '', HOME: home, RC_OUTCOME: JSON.stringify({ text: 'Remote control stopped.' }) },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    // The reader goes away before the plugin gets to write.
    child.stderr!.destroy()
    child.stdout!.resume()
    const code = await new Promise<number | null>((resolve) => child.on('close', (c) => resolve(c)))
    expect(code).toBe(0)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
}, 30_000)

/**
 * Output larger than the pipe buffer arrives whole.
 *
 * A piped stderr is non-blocking inside opencode run, so a single writeSync
 * stores at most what fits in the pipe (64 KiB on Linux) and returns — the rest
 * was silently lost — or throws EAGAIN when the pipe is full, which dropped the
 * whole message. The write has to continue until everything is out.
 */
test('output larger than the pipe buffer reaches the terminal whole', () => {
  const line = 'status line\n'
  const { stderr } = runOpencode(['run', '--command', 'remote-control/status'], { text: line, times: 20_000, tail: 'END-OF-OUTPUT' })
  expect(stderr.length).toBeGreaterThanOrEqual(line.length * 20_000)
  expect(stderr).toContain('END-OF-OUTPUT')
})

test('a stderr nobody reads delays a large output by at most the write deadline', async () => {
  // The write keeps going while the pipe is full, but a reader that never comes
  // must not hang the command.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-run-unread-'))
  try {
    const started = Date.now()
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', FAKE_OPENCODE, OPENCODE_ENTRY, 'run', '--command', 'remote-control/status'],
      {
        env: { PATH: process.env.PATH ?? '', HOME: home, RC_OUTCOME: JSON.stringify({ text: 'status line\n', times: 20_000 }) },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    )
    child.stderr!.pause() // attached, never read
    const code = await new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c)))
    expect(code).toBe(0)
    expect(Date.now() - started).toBeLessThan(10_000)
    child.stderr!.destroy()
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
}, 30_000)

test('processes that draw a screen or serve other clients write nothing to the terminal', () => {
  const quiet: Array<[string[], Record<string, string>]> = [
    // The terminal UI: stderr would scribble over the screen, which already
    // shows the message.
    [[], {}],
    [['/path/to/project'], {}],
    // Servers: the output is in the message their clients show; their stderr
    // is a service log, not the owner's terminal.
    [['serve', '--port', '4096'], {}],
    [['web'], {}],
    // ACP: stdout is the JSON-RPC stream and stderr the editor's log; the model's
    // reply carries the output there (plugin-acp-command-output.test.ts).
    [['acp'], { OPENCODE_CLIENT: 'acp' }],
    [['serve'], { OPENCODE_CLIENT: 'desktop' }],
  ]
  for (const [args, env] of quiet) {
    const { stdout, stderr } = runOpencode(args, { text: 'https://relay.example/s/{session}\nCODE: TEST00' }, env)
    expect({ args, env, stdout, stderr }).toEqual({ args, env, stdout: '', stderr: '' })
  }
})
