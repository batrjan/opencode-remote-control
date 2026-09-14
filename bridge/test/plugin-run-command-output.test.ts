import { expect, test } from 'vitest'
import { spawnSync } from 'node:child_process'
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
const argv = process.argv.slice(2)
const value = (...flags) => {
  const i = argv.findIndex((a) => flags.includes(a))
  return i < 0 ? undefined : argv[i + 1]
}
const outcome = JSON.parse(process.env.RC_OUTCOME)
const hooks = createHooks(async (action, sessionID) => {
  if (outcome.error) throw new Error(outcome.error)
  return outcome.text.replaceAll('{action}', action).replaceAll('{session}', String(sessionID))
})
const output = { parts: [] }
await hooks['command.execute.before'](
  { command: value('--command') ?? 'remote-control/status', sessionID: value('--session', '-s') ?? 'ses_new', arguments: '' },
  output,
)
// The message itself is unchanged: the output is still its only visible part.
if (output.parts.filter((p) => !p.synthetic).length !== 1) throw new Error('message parts changed')
`

type Outcome = { text?: string; error?: string }

function runOpencode(args: string[], outcome: Outcome, extraEnv: Record<string, string> = {}) {
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
    expect(child.status, `fake opencode exited cleanly: ${child.stderr}`).toBe(0)
    return { stdout: child.stdout, stderr: child.stderr }
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
}

/** The words after `opencode` of every inline `opencode run …` in README.md that names a remote-control command. */
function readmeRunLines(): string[][] {
  return [...fs.readFileSync(README, 'utf8').matchAll(/`(opencode run\b[^`]*)`/g)]
    .map((m) => m[1].replace(/\s+/g, ' ').trim())
    .filter((line) => line.includes('remote-control'))
    .map((line) =>
      line
        .split(' ')
        .slice(1)
        .map((w) => w.replace(/^["']|["']$/g, '')),
    )
}

test("README's `opencode run` lines show the command's result on the terminal, not only the model's OK", () => {
  const lines = readmeRunLines()
  expect(lines.length, 'README shows how to run the commands from a terminal').toBeGreaterThan(0)
  for (const words of lines) {
    // A stop that finds nothing must not look like one that ended the share.
    const { stdout, stderr } = runOpencode(words, {
      text: 'session {session} is not shared from this machine — nothing to {action}.\nShared from this machine: ses_other.',
    })
    const action = words[words.indexOf('--command') + 1].split('/')[1]
    expect(stderr, words.join(' ')).toContain(`is not shared from this machine — nothing to ${action}.`)
    expect(stderr, words.join(' ')).toContain('Shared from this machine: ses_other.')
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

test('a start run from a terminal shows the share URL and code', () => {
  const { stderr } = runOpencode(['run', '--command', 'remote-control/start'], {
    text: 'https://relay.example/s/{session}\nCODE: TEST00',
  })
  expect(stderr).toContain('https://relay.example/s/ses_new\nCODE: TEST00')
})

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
    [['acp'], { OPENCODE_CLIENT: 'acp' }],
    [['serve'], { OPENCODE_CLIENT: 'desktop' }],
  ]
  for (const [args, env] of quiet) {
    const { stdout, stderr } = runOpencode(args, { text: 'https://relay.example/s/{session}\nCODE: TEST00' }, env)
    expect({ args, env, stdout, stderr }).toEqual({ args, env, stdout: '', stderr: '' })
  }
})
