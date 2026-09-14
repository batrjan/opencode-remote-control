import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
// @ts-expect-error — the plugin entries are plain ESM JavaScript, no types.
import { tuiEntryRegistered } from '../../plugin/server.js'

/**
 * In a plain `opencode` terminal UI the server entry steps aside when the TUI
 * entry is registered in a tui.json, since that entry registers the same four
 * commands natively (plugin-server.test.ts). It has to look where opencode's
 * terminal UI looks. TuiConfig.loadState of opencode 1.18.30 reads, adding the
 * plugins of each file to one list:
 *
 * - tui.json / tui.jsonc in $XDG_CONFIG_HOME/opencode (~/.config/opencode
 *   without XDG_CONFIG_HOME);
 * - $OPENCODE_TUI_CONFIG;
 * - tui.json(c) and .opencode/tui.json(c) in the working directory and every
 *   parent up to the filesystem root, unless OPENCODE_DISABLE_PROJECT_CONFIG is
 *   "1" or "true";
 * - ~/.opencode/tui.json(c);
 * - $OPENCODE_CONFIG_DIR/tui.json(c), in addition to the global folder;
 *
 * each with {env:NAME} and {file:path} filled in, then parsed as JSONC with
 * trailing commas allowed; a malformed file, or one its schema rejects, is
 * skipped whole.
 *
 * The plugin read ~/.config/opencode (or OPENCODE_CONFIG_DIR instead of it),
 * <cwd>/.opencode and OPENCODE_TUI_CONFIG, and matched "remote-control" in the
 * raw text of a file JSON.parse rejected. On the real binary that went wrong
 * both ways. With the TUI entry in $XDG_CONFIG_HOME/opencode, in ~/.opencode,
 * in a project's .opencode/tui.json with opencode started from a subdirectory,
 * or with OPENCODE_CONFIG_DIR pointing elsewhere, the server entry did not step
 * aside. The `/` menu listed every command twice; since the TUI entry leaves a
 * slash name its server has to that server (plugin-attach-commands.test.ts),
 * the terminal's native commands lost theirs instead, and `/remote-control`
 * ran a model turn answering "OK" where it should open the picker. With the
 * entry commented out in a tui.json, or only in a project file while
 * OPENCODE_DISABLE_PROJECT_CONFIG is set, the server entry stepped aside for a
 * TUI entry opencode never loaded: no /remote-control command at all.
 */

const SPEC = 'opencode-remote-control@git+https://github.com/example/opencode-remote-control.git'
const REGISTERED = JSON.stringify({ plugin: [SPEC] })

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A scratch tree with a home and a project in it, and nothing registered yet. */
function tree() {
  const root = mkdtempSync(path.join(tmpdir(), 'rc-tui-lookup-'))
  roots.push(root)
  const home = path.join(root, 'home')
  const project = path.join(root, 'project')
  mkdirSync(home, { recursive: true })
  mkdirSync(project, { recursive: true })
  const write = (file: string, text = REGISTERED) => {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
  return { root, home, project, write }
}

test('the global tui.json is read from $XDG_CONFIG_HOME/opencode', () => {
  const { root, home, project, write } = tree()
  const xdg = path.join(root, 'xdg')
  write(path.join(xdg, 'opencode', 'tui.json'))
  expect(tuiEntryRegistered(project, { HOME: home, XDG_CONFIG_HOME: xdg })).toBe(true)
})

test('~/.config/opencode is not the global folder when XDG_CONFIG_HOME points elsewhere', () => {
  const { root, home, project, write } = tree()
  write(path.join(home, '.config', 'opencode', 'tui.json'))
  expect(tuiEntryRegistered(project, { HOME: home })).toBe(true)
  // opencode reads $XDG_CONFIG_HOME/opencode instead, and never loads this file.
  expect(tuiEntryRegistered(project, { HOME: home, XDG_CONFIG_HOME: path.join(root, 'xdg') })).toBe(false)
})

test('OPENCODE_CONFIG_DIR is read in addition to the global folder, not instead of it', () => {
  const { root, home, project, write } = tree()
  const extra = path.join(root, 'extra')
  mkdirSync(extra)
  write(path.join(home, '.config', 'opencode', 'tui.json'))
  expect(tuiEntryRegistered(project, { HOME: home, OPENCODE_CONFIG_DIR: extra })).toBe(true)
})

test('tui.json and .opencode/tui.json count in every parent of the working directory', () => {
  const { project, home, write } = tree()
  const src = path.join(project, 'packages', 'app', 'src')
  mkdirSync(src, { recursive: true })
  const env = { HOME: home }
  expect(tuiEntryRegistered(src, env)).toBe(false)

  write(path.join(project, '.opencode', 'tui.json'))
  expect(tuiEntryRegistered(src, env)).toBe(true)

  rmSync(path.join(project, '.opencode'), { recursive: true })
  write(path.join(project, 'tui.jsonc'))
  expect(tuiEntryRegistered(src, env)).toBe(true)
})

test('~/.opencode/tui.json counts', () => {
  const { home, project, write } = tree()
  write(path.join(home, '.opencode', 'tui.json'))
  expect(tuiEntryRegistered(project, { HOME: home })).toBe(true)
})

test('OPENCODE_DISABLE_PROJECT_CONFIG leaves out the project files, but not the global ones', () => {
  const { home, project, write } = tree()
  write(path.join(project, '.opencode', 'tui.json'))
  write(path.join(project, 'tui.json'))
  expect(tuiEntryRegistered(project, { HOME: home })).toBe(true)
  expect(tuiEntryRegistered(project, { HOME: home, OPENCODE_DISABLE_PROJECT_CONFIG: '1' })).toBe(false)
  expect(tuiEntryRegistered(project, { HOME: home, OPENCODE_DISABLE_PROJECT_CONFIG: 'TRUE' })).toBe(false)
  // Any other value is not the flag.
  expect(tuiEntryRegistered(project, { HOME: home, OPENCODE_DISABLE_PROJECT_CONFIG: '0' })).toBe(true)

  write(path.join(home, '.config', 'opencode', 'tui.json'))
  expect(tuiEntryRegistered(project, { HOME: home, OPENCODE_DISABLE_PROJECT_CONFIG: '1' })).toBe(true)
})

test('an entry that is commented out in a tui.json is not registered', () => {
  const { home, project, write } = tree()
  write(
    path.join(home, '.config', 'opencode', 'tui.json'),
    `{\n  // "plugin": ["${SPEC}"],\n  /* "plugin": ["${SPEC}"], */\n  "plugin": []\n}\n`,
  )
  expect(tuiEntryRegistered(project, { HOME: home })).toBe(false)
})

test('a tui.jsonc with comments and trailing commas is read as opencode reads it', () => {
  const { home, project, write } = tree()
  const file = path.join(home, '.config', 'opencode', 'tui.jsonc')
  // "//" inside the spec is part of a string, not a comment.
  write(file, `{\n  // the terminal UI\n  "plugin": [\n    "${SPEC}", // remote control\n  ],\n}\n`)
  expect(tuiEntryRegistered(project, { HOME: home })).toBe(true)

  write(file, `{ "plugin": ["some-other-plugin",], /* "${SPEC}" */ }`)
  expect(tuiEntryRegistered(project, { HOME: home })).toBe(false)

  // Malformed beyond comments and trailing commas: opencode skips the file.
  write(file, `{ "plugin": ["${SPEC}"] `)
  expect(tuiEntryRegistered(project, { HOME: home })).toBe(false)
})

test('a tui.json that starts with a UTF-8 byte order mark is read as opencode reads it', () => {
  // opencode 1.18.30 loads such a file (it drops only a leading mark: one after
  // the "{" makes the file invalid there too). The plugin read the mark as
  // U+FEFF, JSON.parse rejected it and the file was
  // skipped: the server entry registered its commands next to the TUI entry
  // opencode did load, and `/remote-control` ran a model turn answering "OK"
  // instead of opening the picker.
  const BOM = '\uFEFF'
  const { home, project, write } = tree()
  write(path.join(home, '.config', 'opencode', 'tui.json'), BOM + REGISTERED)
  expect(tuiEntryRegistered(project, { HOME: home })).toBe(true)

  rmSync(path.join(home, '.config'), { recursive: true })
  write(path.join(project, '.opencode', 'tui.jsonc'), `${BOM}{\n  // the terminal UI\n  "plugin": ["${SPEC}",],\n}\n`)
  expect(tuiEntryRegistered(project, { HOME: home })).toBe(true)

  // The mark does not make a commented-out entry count.
  write(path.join(project, '.opencode', 'tui.jsonc'), `${BOM}{\n  // "plugin": ["${SPEC}"],\n  "plugin": []\n}\n`)
  expect(tuiEntryRegistered(project, { HOME: home })).toBe(false)
})

test('a tui.json that fails the terminal UI schema does not count', () => {
  // TuiConfig of opencode 1.18.30 checks each file against its schema, after
  // lifting the settings of a "tui" object to the top level. A setting it knows
  // with a value of the wrong type makes it skip the whole file ("skipping
  // invalid tui config"), plugin list included. The plugin looked at the plugin
  // list alone: on the real binary `{ "plugin": [<TUI entry>], "scroll_speed":
  // "fast" }` left the server entry stepping aside for a TUI entry opencode
  // never loaded, and the terminal UI had no /remote-control command at all.
  const { home, project, write } = tree()
  const file = path.join(home, '.config', 'opencode', 'tui.json')
  const env = { HOME: home }
  const registered = (config: object) => {
    write(file, JSON.stringify(config))
    return tuiEntryRegistered(project, env)
  }

  for (const setting of [
    { scroll_speed: 'fast' },
    { scroll_speed: 0 },
    { theme: null },
    { mouse: 'off' },
    { diff_style: 'side-by-side' },
    { leader_timeout: 1.5 },
    { plugin_enabled: { other: 'yes' } },
    { scroll_acceleration: {} },
    { cursor: [] },
    { cursor: { style: 'bar' } },
    { attention: { volume: 2 } },
    { attention: { sounds: { done: 1 } } },
    { prompt: { max_width: 'wide' } },
    { keybinds: { leader: 5 } },
    { keybinds: { app_exit: [true] } },
    { keybinds: { app_exit: { ctrl: true } } },
    { tui: { scroll_speed: 'fast' } },
  ]) {
    expect(registered({ plugin: [SPEC], ...setting }), JSON.stringify(setting)).toBe(false)
  }
  // An entry with options is exactly [spec, object]; anything else fails too.
  for (const entry of [[SPEC], [SPEC, {}, 1], [SPEC, []]]) {
    expect(registered({ plugin: [entry] }), JSON.stringify(entry)).toBe(false)
  }
  expect(registered({ plugin: [SPEC, 5] })).toBe(false)

  // Valid settings keep the entry, and so do settings opencode does not know.
  expect(
    registered({
      $schema: 'https://opencode.ai/tui.json',
      plugin: [[SPEC, { any: 'options' }], 'some-other-plugin'],
      plugin_enabled: { 'some-other-plugin': false },
      theme: 'dark',
      mouse: false,
      diff_style: 'stacked',
      leader_timeout: 500,
      scroll_speed: 0.5,
      scroll_acceleration: { enabled: true },
      cursor: { style: 'line', blinking: false },
      attention: { enabled: true, volume: 0.4, sound_pack: 'x', sounds: { done: './done.wav' }, other: 1 },
      prompt: { max_height: 10, max_width: 'auto' },
      keybinds: {
        leader: 'ctrl+x',
        app_exit: false,
        app_debug: 'none',
        command_list: ['ctrl+p', { name: 'k', ctrl: true }, { key: { name: 'p', meta: true }, event: 'press' }],
      },
      some_future_setting: { anything: true },
    }),
  ).toBe(true)
  // A top-level setting wins over the same one under "tui", and a "tui" that
  // is not an object is dropped.
  expect(registered({ plugin: [SPEC], scroll_speed: 1, tui: { scroll_speed: 'fast' } })).toBe(true)
  expect(registered({ plugin: [SPEC], tui: 'compact' })).toBe(true)
})

test('a plugin list under "tui" counts, as opencode lifts it to the top level', () => {
  // On the real binary `{ "tui": { "plugin": [<TUI entry>] } }` loads the TUI
  // entry, while the plugin saw no top-level list: the server entry registered
  // its commands beside it and `/remote-control` ran a model turn.
  const { home, project, write } = tree()
  const file = path.join(home, '.config', 'opencode', 'tui.json')
  write(file, JSON.stringify({ tui: { plugin: [SPEC] } }))
  expect(tuiEntryRegistered(project, { HOME: home })).toBe(true)
  write(file, JSON.stringify({ plugin: [], tui: { plugin: [SPEC] } }))
  expect(tuiEntryRegistered(project, { HOME: home })).toBe(false)
})

test('{env:NAME} and {file:path} in a tui.json are filled in before it is read', () => {
  // opencode substitutes both in the raw text of the file before parsing it.
  // On the real binary `{ "plugin": ["{env:RC_TUI_SPEC}"] }` loads the TUI
  // entry the variable names, while the plugin saw a spec without
  // "remote-control" in it: the server entry registered its commands beside the
  // TUI entry and `/remote-control` ran a model turn instead of the picker.
  const { home, project, write } = tree()
  const folder = path.join(home, '.config', 'opencode')
  const file = path.join(folder, 'tui.json')

  write(file, '{ "plugin": ["{env:RC_TUI_SPEC}"] }')
  expect(tuiEntryRegistered(project, { HOME: home, RC_TUI_SPEC: SPEC })).toBe(true)
  // A variable that is not set becomes "".
  expect(tuiEntryRegistered(project, { HOME: home })).toBe(false)
  // The value goes in as it is, not as a JSON string, so it can be a number.
  write(file, `{ "plugin": ["${SPEC}"], "scroll_speed": {env:RC_SPEED} }`)
  expect(tuiEntryRegistered(project, { HOME: home, RC_SPEED: '2' })).toBe(true)
  expect(tuiEntryRegistered(project, { HOME: home, RC_SPEED: '"fast"' })).toBe(false)

  // {file:path}: the file's text, trimmed and escaped into the JSON string; a
  // relative path starts at the tui.json's folder, ~/ at the home folder.
  write(path.join(folder, 'rc-spec.txt'), `  ${SPEC}"\n`)
  write(file, '{ "plugin": ["{file:./rc-spec.txt}"] }')
  expect(tuiEntryRegistered(project, { HOME: home })).toBe(true)
  write(path.join(home, 'specs', 'rc.txt'), SPEC)
  write(file, '{ "plugin": ["{file:~/specs/rc.txt}"] }')
  expect(tuiEntryRegistered(project, { HOME: home })).toBe(true)
  // A file that cannot be read becomes "".
  write(file, '{ "plugin": ["{file:./missing-spec.txt}"] }')
  expect(tuiEntryRegistered(project, { HOME: home })).toBe(false)
})
