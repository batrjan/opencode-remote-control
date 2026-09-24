import { expect, test } from 'vitest'
// @ts-expect-error — the plugin entries are plain ESM JavaScript, no types.
import { runsAcp, runsMini, runsTui } from '../../plugin/server.js'

/**
 * Which command lines are NOT a terminal UI.
 *
 * The server entry registers the /remote-control commands as config commands
 * and steps aside in a process that renders the TUI, where the TUI entry
 * registers them natively — otherwise every one of them appears twice in the
 * `/` menu. That decision is made from argv against NON_TUI_SUBCOMMANDS
 * (plugin/server.js), so a subcommand the list does not know is read as "no
 * subcommand", i.e. as a terminal UI, and the plugin registers itself in a
 * process where it should not.
 *
 * The list below is every command word `opencode --help` prints on 1.18.32 —
 * names and aliases both — captured on 2026-09-22 from ~/.opencode/bin/opencode:
 *
 *   opencode providers  … [aliases: auth]
 *   opencode plugin <module>  install plugin and update config  [aliases: plug]
 *
 * Those two are the only aliases it has, and `plug` was the one missing.
 * Re-run `opencode --help` after an upstream bump and compare.
 */
const NON_TUI_COMMAND_WORDS = [
  'completion',
  'acp',
  'mcp',
  'attach',
  'run',
  'debug',
  'providers',
  'auth', // alias of providers
  'agent',
  'upgrade',
  'uninstall',
  'serve',
  'web',
  'models',
  'stats',
  'export',
  'import',
  'github',
  'pr',
  'session',
  'plugin',
  'plug', // alias of plugin
  'db',
]

test.each(NON_TUI_COMMAND_WORDS)('`opencode %s` is not a terminal UI', (word) => {
  expect(runsTui([word], {})).toBe(false)
  expect(runsTui([word, 'an-argument'], {})).toBe(false)
})

/** The regression itself, stated on its own so a bisect names it. */
test('the "plug" alias of `opencode plugin` is recognised', () => {
  expect(runsTui(['plug', 'some-module'], {})).toBe(false)
  expect(runsTui(['plugin', 'some-module'], {})).toBe(false)
  // And it is not mistaken for the two other argv-driven launches either.
  expect(runsMini(['plug', 'some-module', '--mini'])).toBe(false)
  expect(runsAcp(['plug', 'some-module'])).toBe(false)
})

/** What must stay a TUI: no subcommand, or only a project path. */
test('a bare launch is still a terminal UI', () => {
  expect(runsTui([], {})).toBe(true)
  expect(runsTui(['/path/to/project'], {})).toBe(true)
  expect(runsTui(['--print-logs'], {})).toBe(true)
  // A directory that merely looks like a subcommand is a path, but argv gives
  // no way to tell; the list is exact words, so this is the known cost.
  expect(runsTui(['./plugins'], {})).toBe(true)
})
