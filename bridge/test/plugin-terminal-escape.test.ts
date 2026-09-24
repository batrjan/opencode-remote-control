import { expect, test, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * What the plugin prints for the owner is text the RELAY chose.
 *
 * `status` reports the relay's `status`, `title` and `directory` fields, a
 * failed action reports the bridge's error line, and both go straight onto a
 * terminal: stderr in `opencode run` (showInRunTerminal) and the TUI's dialogs
 * and toasts. A hostile or compromised relay answered with control sequences in
 * those fields and the terminal ACTED on them — `ESC]0;…BEL` retitled the
 * window, `ESC[2K ESC[1A` erased the lines the owner had just read and forged
 * others in their place, `OSC 52` wrote the clipboard where the terminal allows
 * it. The plugin asks the relay for a status even for a session it has no state
 * for, so this needs no share of the owner's at all.
 *
 * Nothing here spawns a bridge or contacts a relay: the action runner is
 * stubbed with exactly what such a relay produced.
 */

const SERVER_ENTRY = new URL('../../plugin/server.js', import.meta.url).href

/** Stand-in for the compiled binary's own entry, argv[1] of `opencode`. */
const OPENCODE_ENTRY = '/$bunfs/root/opencode'

/** A relay answer with the sequences a verifier drove a real terminal with. */
const HOSTILE = [
  'session ses_x: active',
  '  directory: \u001b]0;POC-TITLE\u0007\u001b[2K\u001b[1Afake-line\u001b]52;c;UE9D\u0007',
  '  title: \r  bridge: connected',
].join('\n')

/** Every byte a terminal acts on, newline and tab apart. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/

/**
 * A minimal `opencode run`: fires the server entry's command hook once with a
 * runner that answers the way a hostile relay made the bridge answer.
 */
const FAKE_OPENCODE = `
import { createHooks } from ${JSON.stringify(SERVER_ENTRY)}
// opencode run touches stderr for its own lines before any command runs.
void process.stderr.fd
const hooks = createHooks(async () => JSON.parse(process.env.RC_OUTPUT))
await hooks['command.execute.before'](
  { command: 'remote-control/status', sessionID: 'ses_x', arguments: '' },
  { parts: [] },
)
`

test('a relay answer printed by `opencode run` cannot drive the owner’s terminal', () => {
  // A throwaway HOME and no inherited OPENCODE_* variables: the test must not
  // depend on (or touch) the opencode this suite happens to run under.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-tty-escape-'))
  try {
    const child = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', FAKE_OPENCODE, OPENCODE_ENTRY, 'run', '--command', 'remote-control/status'],
      {
        env: { PATH: process.env.PATH ?? '', HOME: home, RC_OUTPUT: JSON.stringify(HOSTILE) },
        encoding: 'utf8',
        timeout: 20_000,
      },
    )
    expect(child.error, 'fake opencode ran').toBeUndefined()
    expect(child.status, `exit status: ${child.stderr}`).toBe(0)
    // The report still reaches the owner, escapes and all — as text.
    expect(child.stderr).toContain('session ses_x: active')
    expect(child.stderr).toContain('fake-line')
    expect(child.stderr, 'the relay text is on stderr as control bytes').not.toMatch(CONTROL)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

/**
 * The TUI entry shows the same text in a dialog or a toast. It runs the bridge
 * itself, so the runner is mocked here rather than injected.
 */
vi.mock('../../plugin/bridge-runner.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  bridgeBin: () => '/nonexistent/bridge.cjs',
  clientParentOf: () => undefined,
  runAction: async () => HOSTILE,
  stopShare: async () => ({ stopped: true, text: HOSTILE }),
}))

type Shown = { title?: string; message?: string }

/** Load the TUI entry into a host that records what its dialogs and toasts show. */
async function loadTui() {
  const shown: Shown[] = []
  const commands: Array<{ name: string; run: () => unknown }> = []
  const api = {
    route: { current: { name: 'session', params: { sessionID: 'ses_x' } } },
    keymap: { registerLayer: (layer: { commands: typeof commands }) => (commands.push(...layer.commands), () => {}) },
    ui: {
      toast: (t: Shown) => shown.push(t),
      dialog: { replace: (make: () => unknown) => make(), clear: () => {} },
      DialogAlert: (props: Shown) => shown.push(props),
      DialogSelect: () => {},
    },
    client: { command: { list: async () => ({ data: [] }) } },
    lifecycle: { signal: { aborted: false } },
  }
  // @ts-expect-error — the plugin entries are plain ESM JavaScript, no types.
  const { default: tuiPlugin } = await import('../../plugin/remote-control.js')
  await tuiPlugin.tui(api)
  return { shown, run: (name: string) => commands.find((c) => c.name === name)?.run() }
}

test('the TUI entry shows a relay answer without handing the terminal control sequences', async () => {
  const { shown, run } = await loadTui()
  await run('remote-control.status')
  await run('remote-control.stop')
  // A start also toasts "Starting…" of its own, before the runner answers.
  await run('remote-control.start')
  const relayed = shown.filter((s) => s.message?.includes('fake-line'))
  expect(relayed.length, 'status, stop and start each showed the relay answer').toBe(3)
  for (const { title, message } of shown) {
    expect(message, `${title}: the relay text is in the dialog as control bytes`).not.toMatch(CONTROL)
  }
})
