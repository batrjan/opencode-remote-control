import { expect, test } from 'vitest'
// @ts-expect-error — the plugin entries are plain ESM JavaScript, no types.
import tuiPlugin from '../../plugin/remote-control.js'

/**
 * `opencode attach <url>` is a terminal UI whose server is another process —
 * `opencode serve`, the web UI or the desktop app. README recommends exactly
 * that pairing, and install.sh registers both plugin entries, so that server
 * has the server entry's four commands and the terminal has the TUI entry's.
 *
 * The `/` menu of opencode 1.18.30 is the server's command list followed by the
 * slash names of the commands registered through api.keymap, with no check for
 * a name that is already there. The server cannot step aside — it has no way to
 * know a terminal UI will attach, and the web and desktop clients of the same
 * server need its commands — so every command showed twice: `/remote-control`,
 * `/remote-control/start`, `/remote-control/stop` and `/remote-control/status`,
 * eight rows. `opencode attach --mini` loads no TUI plugin and showed four.
 *
 * The TUI entry is loaded here against a fake host that builds that menu the
 * same way.
 */

const NAMES = ['remote-control', 'remote-control/start', 'remote-control/stop', 'remote-control/status']

type Command = { name: string; title?: string; slashName?: string; namespace?: string; run: () => unknown }

/** The server's `command.list` answer, as the SDK the TUI hands its plugins returns it. */
const served = (names: string[]) => ({ data: names.map((name) => ({ name, description: `server ${name}`, template: ' ' })) })

/**
 * Load the TUI entry into a host attached to a server that has the commands
 * `serverNames`. The host's own bootstrap has already fetched that list for its
 * menu; what the plugin gets when it asks is up to `answer` (by default the same
 * list). Returns the host's live view: the `/` menu and the palette.
 */
async function loadTui(
  serverNames: string[],
  { answer = async () => served(serverNames) as unknown, aborted = () => false } = {},
) {
  const layers = new Set<{ commands: Command[] }>()
  let registrations = 0
  const api = {
    route: { current: { name: 'home' } },
    keymap: {
      // Like the real keymap: the returned function takes the layer out again.
      registerLayer: (layer: { commands: Command[] }) => {
        registrations += 1
        layers.add(layer)
        return () => layers.delete(layer)
      },
    },
    ui: {
      toast: () => {},
      dialog: { replace: () => {}, clear: () => {} },
      DialogAlert: () => {},
      DialogSelect: () => {},
    },
    client: { command: { list: () => answer() } },
    lifecycle: {
      get signal() {
        return { aborted: aborted() } as AbortSignal
      },
      onDispose: () => () => {},
    },
  }
  await tuiPlugin.tui(api)
  const commands = () => [...layers].flatMap((l) => l.commands)
  return {
    /** The `/` menu: the server's commands, then the keymap's slash names (opencode 1.18.30). */
    menu: () => [...serverNames, ...commands().flatMap((c) => (c.slashName ? [c.slashName] : []))],
    /** The command palette (ctrl+p): every keymap command, slash name or not. */
    palette: () => commands().map((c) => c.name),
    registrations: () => registrations,
  }
}

/** Let the plugin's pending work (the command list it asked for) settle. */
const settle = () => new Promise((r) => setTimeout(r, 20))

const rowsOf = (menu: string[], name: string) => menu.filter((n) => n === name).length

test('attached to a server that has the commands, the / menu lists each of them once', async () => {
  const tui = await loadTui(['init', 'review', ...NAMES])
  await settle()
  for (const name of NAMES) expect(rowsOf(tui.menu(), name), `/${name} rows in the / menu`).toBe(1)
  // The native, LLM-free actions stay reachable from the palette.
  expect(tui.palette()).toEqual([
    'remote-control.menu',
    'remote-control.start',
    'remote-control.stop',
    'remote-control.status',
  ])
})

test('a server without the commands leaves the TUI its own slash names', async () => {
  // A plain `opencode` TUI (its server entry steps aside) or a tui.json-only install.
  const tui = await loadTui(['init', 'review'])
  await settle()
  for (const name of NAMES) expect(rowsOf(tui.menu(), name), `/${name}`).toBe(1)
})

test('only the names the server has are left to it', async () => {
  const tui = await loadTui(['remote-control/status'])
  await settle()
  for (const name of NAMES) expect(rowsOf(tui.menu(), name), `/${name}`).toBe(1)
  expect(tui.palette()).toHaveLength(4)
})

test('the commands are there at once, and stay when the server never answers or fails', async () => {
  // Registration does not wait for the server: a slow or unreachable one must
  // not hold up the TUI entry.
  const pending = await loadTui([], { answer: () => new Promise(() => {}) })
  expect(pending.menu()).toEqual(NAMES)
  expect(pending.palette()).toHaveLength(4)

  const failing = await loadTui([], {
    answer: async () => {
      throw new Error('connection refused')
    },
  })
  await settle()
  expect(failing.menu()).toEqual(NAMES)
  expect(failing.palette()).toHaveLength(4)
})

test('a plugin disposed before the server answers registers nothing again', async () => {
  let release: ((v: unknown) => void) | undefined
  let disposed = false
  const tui = await loadTui(NAMES, {
    answer: () => new Promise((r) => (release = r)),
    aborted: () => disposed,
  })
  disposed = true
  release?.(served(NAMES))
  await settle()
  // Taking a disposed plugin's layers out is the host's job; the plugin must
  // not add a new one behind its back.
  expect(tui.registrations()).toBe(1)
})
