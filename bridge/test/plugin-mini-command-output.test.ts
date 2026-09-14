import { expect, test } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// @ts-expect-error — the plugin entries are plain ESM JavaScript, no types.
import { runsMini } from '../../plugin/server.js'

/**
 * Whether an owner who types a remote-control command in `opencode --mini`
 * gets to see what it did.
 *
 * Mini (opencode 1.18.30) loads no tui.json plugin, so its /remote-control
 * commands are the server entry's. The server entry puts the action's output
 * into the command's user message and told the model to answer with exactly
 * "OK". Mini never draws that message live — only the reply — so
 * `/remote-control/start` showed no URL and no code, and `/remote-control/status`
 * nothing at all; the output surfaced only when the session was replayed (a
 * window resize, or reopening it). stderr, /dev/tty, toasts and appendPrompt are
 * all painted over or dropped, so the model's reply is the only channel mini
 * shows: there the model has to repeat the output instead.
 *
 * Even that reply stayed invisible. Mini ends a command's turn as soon as
 * session.command answers, and that answer came back before the reply's text
 * reached mini's event stream. The last line of streamed text is drawn only
 * when a turn ends, so the reply sat undrawn until the next prompt. Holding the
 * reply's text completion back for a moment lets the text arrive while the turn
 * is still running.
 *
 * Each case runs the server entry's hooks in a child process whose argv is laid
 * out like the opencode binary's (`<runtime> <entry> …`), the way the real
 * process loads the plugin. The action is stubbed: nothing spawns a bridge.
 */

const SERVER_ENTRY = new URL('../../plugin/server.js', import.meta.url).href

/** Stand-ins for argv[1] of the compiled binary and of its terminal-UI worker. */
const OPENCODE_ENTRY = '/$bunfs/root/src/index.js'
const TUI_WORKER_ENTRY = '/$bunfs/root/src/cli/tui/worker.js'

const OUTPUT = 'https://relay.example/s/ses_cmd\nCODE: TEST00'

/**
 * Fires the command hook once, then completes reply text the way the session
 * processor does (experimental.text.complete at the end of each text part):
 * first in an unrelated session, then twice in the command's session. `held`
 * says whether a completion was still pending after a 20 ms timer.
 */
const FAKE_OPENCODE = `
import { createHooks } from ${JSON.stringify(SERVER_ENTRY)}
const hooks = createHooks(async () => ${JSON.stringify(OUTPUT)})
const output = { parts: [{ type: 'text', text: ' ' }] }
// The command named by --command, as opencode run takes it; start otherwise.
const commandArg = process.argv.indexOf('--command')
const command = commandArg < 0 ? 'remote-control/start' : process.argv[commandArg + 1]
await hooks['command.execute.before']({ command, sessionID: 'ses_cmd', arguments: '' }, output)
async function complete(sessionID) {
  const hook = hooks['experimental.text.complete']
  if (!hook) return { held: false, ms: 0, text: 'reply' }
  const text = { text: 'reply' }
  const started = performance.now()
  const done = Promise.resolve(hook({ sessionID, messageID: 'msg_reply', partID: 'prt_reply' }, text))
  const held = await Promise.race([done.then(() => false), new Promise((r) => setTimeout(() => r(true), 20))])
  await done
  return { held, ms: performance.now() - started, text: text.text }
}
const other = await complete('ses_other')
const reply = await complete('ses_cmd')
const later = await complete('ses_cmd')
process.stdout.write(JSON.stringify({ parts: output.parts, other, reply, later }))
`

type Completion = { held: boolean; ms: number; text: string }
type Result = { parts: Array<{ type: string; text: string; synthetic?: boolean }>; other: Completion; reply: Completion; later: Completion }

function runOpencode(args: string[], env: Record<string, string> = {}, entry = OPENCODE_ENTRY): Result {
  // A throwaway HOME and no inherited OPENCODE_* variables: the test must not
  // depend on (or touch) the opencode this suite happens to run under.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-mini-output-'))
  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', FAKE_OPENCODE, entry, ...args], {
      env: { PATH: process.env.PATH ?? '', HOME: home, ...env },
      encoding: 'utf8',
      timeout: 20_000,
    })
    expect(child.error, 'fake opencode ran').toBeUndefined()
    expect(child.status, `fake opencode exited cleanly: ${child.stderr}`).toBe(0)
    return JSON.parse(child.stdout) as Result
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
}

const instructionOf = (result: Result) => result.parts.filter((p) => p.synthetic).map((p) => p.text).join('\n')

test('in opencode --mini the reply carries the output, and it reaches the screen before the turn ends', () => {
  const launches: Array<[string[], Record<string, string>]> = [
    [['--mini'], {}],
    [['--mini', '/path/to/project'], {}],
    [['--continue', '--mini=true'], {}],
    // Started from a terminal inside the desktop app: OPENCODE_CLIENT is inherited.
    [['--mini'], { OPENCODE_CLIENT: 'desktop' }],
  ]
  for (const [args, env] of launches) {
    const label = `opencode ${args.join(' ')} ${JSON.stringify(env)}`
    const result = runOpencode(args, env)
    // The message itself is unchanged: the output is its only visible part.
    expect(result.parts.filter((p) => !p.synthetic), label).toEqual([{ type: 'text', text: OUTPUT }])
    // Mini draws only the reply, so the reply has to be the output.
    const instruction = instructionOf(result)
    expect(instruction, label).toMatch(/already ran this command/i)
    expect(instruction, label).toMatch(/verbatim/i)
    expect(instruction, label).not.toMatch(/single word OK/i)
    // The reply's text is held back long enough for mini to receive it while
    // the turn still runs, but only for that reply, never for long, and never
    // rewritten.
    expect(result.reply, label).toEqual({ held: true, ms: expect.any(Number), text: 'reply' })
    expect(result.reply.ms, label).toBeLessThan(2_000)
    expect(result.later, label).toEqual({ held: false, ms: expect.any(Number), text: 'reply' })
    expect(result.other, label).toEqual({ held: false, ms: expect.any(Number), text: 'reply' })
  }
})

test('clients that show the message keep the plain OK acknowledgement and an undelayed reply', () => {
  const clients: Array<[string[], Record<string, string>, string?]> = [
    // The full terminal UI runs its server side in a worker with no argv.
    [[], {}, TUI_WORKER_ENTRY],
    [[], { OPENCODE_CLIENT: 'desktop' }, TUI_WORKER_ENTRY],
    // The desktop sidecar: no subcommand at all.
    [[], { OPENCODE_CLIENT: 'desktop' }],
    // Servers (web UI, desktop, `attach` clients) and `opencode run`, which
    // prints the output on stderr instead.
    [['serve', '--port', '4096'], {}],
    [['web'], {}],
    [['run', '--command', 'remote-control/status'], {}],
  ]
  for (const [args, env, entry] of clients) {
    const label = `${entry ?? OPENCODE_ENTRY} ${args.join(' ')} ${JSON.stringify(env)}`
    const result = runOpencode(args, env, entry)
    expect(result.parts.filter((p) => !p.synthetic), label).toEqual([{ type: 'text', text: OUTPUT }])
    expect(instructionOf(result), label).toMatch(/single word OK/i)
    expect(instructionOf(result), label).not.toMatch(/verbatim/i)
    for (const completion of [result.other, result.reply, result.later]) {
      expect(completion, label).toEqual({ held: false, ms: expect.any(Number), text: 'reply' })
    }
  }
})

test('runsMini recognises the process that draws the mini interface', () => {
  expect(runsMini(['--mini'], OPENCODE_ENTRY)).toBe(true)
  expect(runsMini(['/path/to/project', '--mini'], OPENCODE_ENTRY)).toBe(true)
  expect(runsMini(['--mini=true'], OPENCODE_ENTRY)).toBe(true)
  // The full terminal UI and its worker.
  expect(runsMini([], OPENCODE_ENTRY)).toBe(false)
  expect(runsMini(['--mini'], TUI_WORKER_ENTRY)).toBe(false)
  // `attach --mini` draws mini, but its commands run in the server it attached
  // to — a process that cannot tell which client typed them.
  expect(runsMini(['serve'], OPENCODE_ENTRY)).toBe(false)
  expect(runsMini(['attach', 'http://127.0.0.1:4096', '--mini'], OPENCODE_ENTRY)).toBe(false)
  expect(runsMini(['run', '--command', 'remote-control/status'], OPENCODE_ENTRY)).toBe(false)
})
