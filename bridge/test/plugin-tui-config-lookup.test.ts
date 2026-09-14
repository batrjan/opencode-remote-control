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
 * each parsed as JSONC with trailing commas allowed, a malformed file skipped.
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
