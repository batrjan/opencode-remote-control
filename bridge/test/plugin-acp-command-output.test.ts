import { expect, test } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// @ts-expect-error — the plugin entries are plain ESM JavaScript, no types.
import * as serverEntry from '../../plugin/server.js'

/**
 * Whether an owner who types a remote-control command in an ACP client (Zed or
 * any other editor driving `opencode acp`) gets to see what it did.
 *
 * `opencode acp` runs its own server in the same process, so the command runs
 * in the server entry's `command.execute.before` there, and the output becomes
 * the command's user message. The ACP agent of opencode 1.18.30 never streams
 * that message: it forwards only the assistant's text and reasoning deltas,
 * tool calls and permission requests while a prompt runs, and sends user
 * message chunks only when a thread is reopened (session/load). stdout is the
 * JSON-RPC stream and stderr the editor's log, so no side channel is left.
 * With the model told to answer with exactly "OK", `/remote-control/start`
 * showed the client a bare "OK" — no URL, no code — and `/remote-control/status`
 * the same whatever it found. The model's reply is the only thing the client
 * shows live, so there it has to repeat the output instead.
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
 * Fires the command hook once, then completes the reply's text the way the
 * session processor does (experimental.text.complete). `held` says whether the
 * completion was still pending after a 20 ms timer.
 */
const FAKE_OPENCODE = `
import { createHooks } from ${JSON.stringify(SERVER_ENTRY)}
const hooks = createHooks(async () => ${JSON.stringify(OUTPUT)})
const output = { parts: [{ type: 'text', text: ' ' }] }
await hooks['command.execute.before']({ command: 'remote-control/start', sessionID: 'ses_cmd', arguments: '' }, output)
let held = false
const hook = hooks['experimental.text.complete']
if (hook) {
  const done = Promise.resolve(hook({ sessionID: 'ses_cmd', messageID: 'msg_reply', partID: 'prt_reply' }, { text: 'reply' }))
  held = await Promise.race([done.then(() => false), new Promise((r) => setTimeout(() => r(true), 20))])
  await done
}
process.stdout.write(JSON.stringify({ parts: output.parts, held }))
`

type Result = { parts: Array<{ type: string; text: string; synthetic?: boolean }>; held: boolean }

function runOpencode(args: string[], env: Record<string, string> = {}, entry = OPENCODE_ENTRY): Result {
  // A throwaway HOME and no inherited OPENCODE_* variables: the test must not
  // depend on (or touch) the opencode this suite happens to run under.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-acp-output-'))
  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', FAKE_OPENCODE, entry, ...args], {
      env: { PATH: process.env.PATH ?? '', HOME: home, ...env },
      encoding: 'utf8',
      timeout: 20_000,
    })
    expect(child.error, 'fake opencode ran').toBeUndefined()
    expect(child.status, `fake opencode exited cleanly: ${child.stderr}`).toBe(0)
    // Nothing on stdout but the result: under ACP stdout is the JSON-RPC stream.
    return JSON.parse(child.stdout) as Result
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
}

const instructionOf = (result: Result) => result.parts.filter((p) => p.synthetic).map((p) => p.text).join('\n')

test('under opencode acp the reply carries the output', () => {
  const launches: string[][] = [['acp'], ['acp', '--cwd', '/path/to/project'], ['--print-logs', 'acp', '--port', '0']]
  for (const args of launches) {
    // `opencode acp` sets OPENCODE_CLIENT=acp for itself before it loads plugins.
    const label = `opencode ${args.join(' ')}`
    const result = runOpencode(args, { OPENCODE_CLIENT: 'acp' })
    // The message itself is unchanged: the output is its only visible part.
    expect(result.parts.filter((p) => !p.synthetic), label).toEqual([{ type: 'text', text: OUTPUT }])
    // The client shows only the reply, so the reply has to be the output.
    const instruction = instructionOf(result)
    expect(instruction, label).toMatch(/already ran this command/i)
    expect(instruction, label).toMatch(/verbatim/i)
    expect(instruction, label).not.toMatch(/single word OK/i)
    // The ACP agent answers a prompt only once the session is idle, after every
    // reply delta went out, so unlike mini the reply is never held back.
    expect(result.held, label).toBe(false)
  }
})

test('processes that only inherited OPENCODE_CLIENT=acp keep the plain OK acknowledgement', () => {
  // The ACP agent's environment reaches every child it starts: a bash tool call
  // running `opencode run`, or a terminal UI opened from one. Those show the
  // output in their own way (stderr for run, the message for the TUI).
  const clients: Array<[string[], string?]> = [
    [['run', '--command', 'remote-control/start']],
    [['serve', '--port', '4096']],
    [[], TUI_WORKER_ENTRY],
    [['attach', 'http://127.0.0.1:4096']],
  ]
  for (const [args, entry] of clients) {
    const label = `${entry ?? OPENCODE_ENTRY} ${args.join(' ')}`
    const result = runOpencode(args, { OPENCODE_CLIENT: 'acp' }, entry)
    expect(result.parts.filter((p) => !p.synthetic), label).toEqual([{ type: 'text', text: OUTPUT }])
    expect(instructionOf(result), label).toMatch(/single word OK/i)
    expect(instructionOf(result), label).not.toMatch(/verbatim/i)
  }
})

test('runsAcp recognises the opencode acp process by its subcommand', () => {
  const { runsAcp } = serverEntry as { runsAcp?: (argv: string[]) => boolean }
  expect(typeof runsAcp, 'server.js exports runsAcp').toBe('function')
  expect(runsAcp!(['acp'])).toBe(true)
  expect(runsAcp!(['acp', '--cwd', '/path/to/project'])).toBe(true)
  expect(runsAcp!(['--print-logs', 'acp'])).toBe(true)
  // The first subcommand decides: a message that mentions acp is not one.
  expect(runsAcp!(['run', 'what is acp'])).toBe(false)
  expect(runsAcp!([])).toBe(false)
  expect(runsAcp!(['--mini'])).toBe(false)
  expect(runsAcp!(['serve'])).toBe(false)
})
