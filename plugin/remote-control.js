// remote-control TUI plugin for OpenCode (terminal UI).
//
// Registers /remote-control plus /remote-control/start|stop|status, which run
// the local bridge DIRECTLY — no LLM prompt, no agent reasoning, instant.
//
// Install from git: add to ~/.config/opencode/tui.json →
//   "plugin": ["opencode-remote-control@git+https://github.com/batrjan/opencode-remote-control.git"]
// TUI plugins load ONLY from tui.json. The desktop GUI and `opencode run` have
// no TUI at all — they get the same actions from the server entry (./server,
// registered through opencode.json). See plugin/server.js.

import { bridgeBin, runAction } from "./bridge-runner.js"
export { parseBridgeLog } from "./bridge-runner.js"

export const id = "remote-control"

export async function tui(api) {
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
      // Bind to the CURRENT session (the route the user is on), not an
      // arbitrary project, so /remote-control/start never shares the
      // wrong session.
      const sessionID = api.route.current.name === "session" ? api.route.current.params.sessionID : undefined
      const out = await runAction("start", sessionID)
      api.ui.dialog.replace(() =>
        api.ui.DialogAlert({
          title: "Remote control",
          message: out,
          onConfirm: () => api.ui.dialog.clear(),
        }),
      )
    } catch (err) {
      api.ui.toast({ variant: "error", title: "start failed", message: String(err?.message ?? err), duration: 8000 })
    }
  }

  const showStop = async () => {
    try {
      const out = await runAction("stop")
      api.ui.toast({ variant: "success", title: "remote-control", message: out || "Remote control stopped.", duration: 4000 })
    } catch (err) {
      api.ui.toast({ variant: "error", title: "stop failed", message: String(err?.message ?? err), duration: 8000 })
    }
  }

  const showStatus = async () => {
    try {
      const out = await runAction("status")
      api.ui.dialog.replace(() =>
        api.ui.DialogAlert({
          title: "Remote control status",
          message: out || "no active session",
          onConfirm: () => api.ui.dialog.clear(),
        }),
      )
    } catch (err) {
      api.ui.toast({ variant: "error", title: "status failed", message: String(err?.message ?? err), duration: 8000 })
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

  api.keymap.registerLayer({
    commands: [
      {
        name: "remote-control.menu",
        title: "Remote control",
        desc: "Share this session on the web",
        slashName: "remote-control",
        category: "Remote Control",
        namespace: "palette",
        run: showMenu,
      },
      {
        name: "remote-control.start",
        title: "Start remote control (share this session)",
        slashName: "remote-control/start",
        category: "Remote Control",
        namespace: "palette",
        run: showStart,
      },
      {
        name: "remote-control.stop",
        title: "Stop remote control",
        slashName: "remote-control/stop",
        category: "Remote Control",
        namespace: "palette",
        run: showStop,
      },
      {
        name: "remote-control.status",
        title: "Remote control status",
        slashName: "remote-control/status",
        category: "Remote Control",
        namespace: "palette",
        run: showStatus,
      },
    ],
  })
}

export default { id, tui }
