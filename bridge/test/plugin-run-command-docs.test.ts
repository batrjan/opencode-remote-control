import { expect, test } from 'vitest'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
// @ts-expect-error — the plugin entries are plain ESM JavaScript, no types.
import { createHooks } from '../../plugin/server.js'

/**
 * Whether the `opencode run` lines README.md gives for the remote-control
 * commands actually run them.
 *
 * `opencode run` hands its words to session.command only with `--command`;
 * every other word is sent through session.prompt as an ordinary user message,
 * slash or not (opencode 1.18.30's run handler). The server entry acts only in
 * `command.execute.before`, which fires on the command path alone. README told
 * owners to cut a viewer off with `opencode run --session <id>
 * /remote-control/stop`: that stopped nothing, left the access code and the
 * viewer's prompts, shell and files live, and put "/remote-control/stop" into
 * the shared session as a prompt the viewer could read, starting a model turn.
 * `opencode run "/remote-control/start"` likewise started no share.
 */

const README = fileURLToPath(new URL('../../README.md', import.meta.url))

/** `opencode run` options that take a value, so the value is not a message word. */
const VALUE_OPTIONS = new Set([
  '--command',
  '-s',
  '--session',
  '-m',
  '--model',
  '--agent',
  '--format',
  '-f',
  '--file',
  '--title',
  '--variant',
  '--attach',
  '-p',
  '--password',
  '-u',
  '--username',
  '--port',
  '--dir',
  '--log-level',
])

type RunExample = { line: string; options: Map<string, string>; message: string[] }

/** Every inline `opencode run …` in the README that names a remote-control command. */
function runExamples(markdown: string): RunExample[] {
  return [...markdown.matchAll(/`(opencode run\b[^`]*)`/g)]
    .map((m) => m[1].replace(/\s+/g, ' ').trim())
    .filter((line) => line.includes('remote-control'))
    .map((line) => {
      const words = line
        .split(' ')
        .slice(2)
        .map((w) => w.replace(/^["']|["']$/g, ''))
      const options = new Map<string, string>()
      const message: string[] = []
      for (let i = 0; i < words.length; i++) {
        const [flag, inline] = words[i].split(/=(.*)/s)
        if (VALUE_OPTIONS.has(flag)) options.set(flag, inline ?? words[++i])
        else if (words[i].startsWith('-')) options.set(words[i], '')
        else message.push(words[i])
      }
      return { line, options, message }
    })
}

test("README's `opencode run` lines pass remote-control commands with --command, never as a message", async () => {
  const hooks = createHooks(async () => 'unused', () => true)
  const config: { command?: Record<string, unknown> } = {}
  await hooks.config!(config)
  const registered = Object.keys(config.command!)

  const examples = runExamples(fs.readFileSync(README, 'utf8'))
  expect(examples.length, 'README shows how to run the commands from a terminal').toBeGreaterThan(0)
  for (const { line, options, message } of examples) {
    // A slash word is a prompt to the model, not a command: nothing runs.
    expect(message.filter((w) => w.startsWith('/')), line).toEqual([])
    // The name session.command looks up, exactly as the config hook registers it.
    expect(registered, line).toContain(options.get('--command'))
  }
  // The terminal stop an owner is pointed to from a session with no share has
  // to name that session, or it would act on a new, unshared one.
  expect(
    examples.some((e) => e.options.get('--command') === 'remote-control/stop' && e.options.get('--session')),
    'README shows a terminal stop for a named session',
  ).toBe(true)
})
