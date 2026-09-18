// remote-control TUI plugin for OpenCode (terminal UI).
//
// Registers /remote-control plus /remote-control/start|stop|status, which run
// the local bridge DIRECTLY — no LLM prompt, no agent reasoning, instant. In
// `opencode attach` to a server that has these commands itself, the slash names
// are left to that server and these stay in the command palette (see tui()).
//
// Install from git: add to ~/.config/opencode/tui.json →
//   "plugin": ["opencode-remote-control@git+https://github.com/batrjan/opencode-remote-control.git"]
// TUI plugins load ONLY from tui.json. The desktop GUI and `opencode run` have
// no TUI at all — they get the same actions from the server entry (./server,
// registered through opencode.json). See plugin/server.js.

import { bridgeBin, clientParentOf, runAction, sanitizeForTerminal, stopShare } from "./bridge-runner.js"
export { parseBridgeLog } from "./bridge-runner.js"

export const id = "remote-control"

/**
 * A failed action as the owner is shown it: the bridge's error line, which
 * quotes what the relay said, so it goes on a terminal sanitized (see
 * sanitizeForTerminal).
 */
const errorText = (err) => sanitizeForTerminal(String(err?.message ?? err))

/** The slash names the server entry registers as well. */
const SLASH_NAMES = ["remote-control", "remote-control/start", "remote-control/stop", "remote-control/status"]

/** The command names the server behind `client` lists; empty when it cannot say. */
async function servedCommandNames(client) {
  try {
    const res = await client?.command?.list?.()
    const list = Array.isArray(res) ? res : res?.data
    return new Set(Array.isArray(list) ? list.map((c) => c?.name).filter((n) => typeof n === "string") : [])
  } catch {
    return new Set()
  }
}

export async function tui(api) {
  // The session the user is looking at. Every action binds to it — start so it
  // never shares the wrong session, stop/status so they never act on another
  // share running on this machine. Undefined off a session route (home screen).
  const currentSessionID = () =>
    api.route.current.name === "session" ? api.route.current.params.sessionID : undefined

  // The parent of a session, so stop/status typed in a subagent session (the
  // TUI routes into one whenever the owner opens a subagent) reach the share
  // it belongs to. The synced TUI state answers without a request; a session
  // it does not hold is asked of the server.
  const fromClient = clientParentOf(api.client)
  const parentOf = async (id) => {
    const known = api.state?.session?.get?.(id)
    if (known) return typeof known.parentID === "string" ? known.parentID : undefined
    return fromClient ? await fromClient(id) : undefined
  }

  const showStart = async () => {
    if (!bridgeBin()) {
      api.ui.toast({
        variant: "error",
        title: "remote-control",
        message: "bridge not installed — reinstall the plugin from git",
        duration: 8000,
      })
      return
    }
    api.ui.toast({ variant: "info", title: "remote-control", message: "Starting…", duration: 3000 })
    try {
      const out = sanitizeForTerminal(await runAction("start", currentSessionID()))
      api.ui.dialog.replace(() =>
        api.ui.DialogAlert({
          title: "Remote control",
          message: out,
          onConfirm: () => api.ui.dialog.clear(),
        }),
      )
    } catch (err) {
      api.ui.toast({ variant: "error", title: "start failed", message: errorText(err), duration: 8000 })
    }
  }

  const showStop = async () => {
    try {
      const { stopped, text: raw } = await stopShare(currentSessionID(), { parentOf })
      const text = sanitizeForTerminal(raw)
      // A stop that found no share to end is not a success: the share the
      // owner meant is still live, and the message says where it runs.
      api.ui.toast(
        stopped
          ? { variant: "success", title: "remote-control", message: text, duration: 4000 }
          : { variant: "warning", title: "remote-control", message: text, duration: 10000 },
      )
    } catch (err) {
      api.ui.toast({ variant: "error", title: "stop failed", message: errorText(err), duration: 8000 })
    }
  }

  const showStatus = async () => {
    try {
      const out = sanitizeForTerminal(await runAction("status", currentSessionID(), { parentOf }))
      api.ui.dialog.replace(() =>
        api.ui.DialogAlert({
          title: "Remote control status",
          message: out || "no active session",
          onConfirm: () => api.ui.dialog.clear(),
        }),
      )
    } catch (err) {
      api.ui.toast({ variant: "error", title: "status failed", message: errorText(err), duration: 8000 })
    }
  }

  // Typing the bare `/remote-control` used to match nothing runnable — Enter
  // sent it to the model as a prompt. The flat command opens a picker for the
  // three actions; the nested ones stay for direct access.
  const showMenu = () => {
    api.ui.dialog.replace(() =>
      api.ui.DialogSelect({
        title: "Remote control",
        options: [
          { title: "Start — share this session", value: "start", onSelect: () => void showStart() },
          { title: "Status — relay, session, viewers", value: "status", onSelect: () => void showStatus() },
          { title: "Stop — end the share", value: "stop", onSelect: () => void showStop() },
        ],
      }),
    )
  }

  // The commands, with the slash names in `served` left out (see below).
  const commands = (served) => {
    const slash = (name) => (served.has(name) ? undefined : name)
    return [
      {
        name: "remote-control.menu",
        title: "Remote control",
        desc: "Share this session on the web",
        slashName: slash("remote-control"),
        category: "Remote Control",
        namespace: "palette",
        run: showMenu,
      },
      {
        name: "remote-control.start",
        title: "Start remote control (share this session)",
        slashName: slash("remote-control/start"),
        category: "Remote Control",
        namespace: "palette",
        run: showStart,
      },
      {
        name: "remote-control.stop",
        title: "Stop remote control",
        slashName: slash("remote-control/stop"),
        category: "Remote Control",
        namespace: "palette",
        run: showStop,
      },
      {
        name: "remote-control.status",
        title: "Remote control status",
        slashName: slash("remote-control/status"),
        category: "Remote Control",
        namespace: "palette",
        run: showStatus,
      },
    ]
  }

  let unregister = api.keymap.registerLayer({ commands: commands(new Set()) })

  // `opencode attach <url>` to a server that has the server entry (an `opencode
  // serve` with it in opencode.json, as README recommends) showed every command
  // twice: the `/` menu lists the server's commands and then these slash
  // names, and keeps both rows of a name. The server cannot step aside — it
  // cannot know a terminal will attach, and its web and desktop clients need
  // the commands — so this entry does: the slash names that server already has
  // are left to it, and typing one runs the server's command, in the server.
  // The native actions stay in the command palette. A plain `opencode` TUI is
  // unaffected: its server steps aside instead (defaultRegisterCommands).
  //
  // Asked without waiting, so a slow or unreachable server never holds up the
  // commands; if it cannot answer, the slash names simply stay.
  void servedCommandNames(api.client)
    .then((served) => {
      if (!SLASH_NAMES.some((name) => served.has(name))) return
      if (api.lifecycle?.signal?.aborted || typeof unregister !== "function") return
      unregister()
      unregister = api.keymap.registerLayer({ commands: commands(served) })
    })
    .catch(() => {})
}

export default { id, tui }
