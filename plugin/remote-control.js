// remote-control native TUI plugin for OpenCode.
//
// Registers slash commands /remote-control start|stop|status that run the
// local bridge DIRECTLY (no LLM prompt, no agent reasoning — instant).
//
// Install: copy to ~/.config/opencode/plugins/remote-control.js

import { spawn, execFile } from "node:child_process"
import { openSync, existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

const RELAY = "https://opencode.b4tr.net"
const BIN = path.join(homedir(), ".agents", "skills", "remote-control", "bin", "index.js")
const LOG = "/tmp/remote-control.log"

function bridgeMissing() {
  return !existsSync(BIN)
}

/** Start the bridge detached, logging to LOG; resolve once it prints URL+CODE. */
function startBridge() {
  return new Promise((resolve, reject) => {
    const out = openSync(LOG, "w")
    const child = spawn("node", [BIN, "start", "--relay", RELAY], {
      detached: true,
      stdio: ["ignore", out, out],
    })
    child.unref()
    let settled = false
    const fail = (msg) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(msg))
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        const text = readFileSync(LOG, "utf8").trim()
        reject(new Error(text || "timeout waiting for the bridge"))
      } catch {
        reject(new Error("timeout waiting for the bridge"))
      }
    }, 30_000)
    const poll = setInterval(() => {
      if (settled) return clearInterval(poll)
      let text = ""
      try {
        text = readFileSync(LOG, "utf8")
      } catch {
        return
      }
      const lines = text.trim().split("\n").filter(Boolean)
      if (lines.some((l) => l.startsWith("CODE:"))) {
        settled = true
        clearInterval(poll)
        clearTimeout(timer)
        resolve(lines.slice(0, 2).join("\n"))
      } else if (lines.some((l) => /failed|error/i.test(l))) {
        fail(lines.join("\n"))
      }
    }, 250)
    child.on("error", (err) => fail(String(err)))
  })
}

/** Run a short-lived bridge subcommand; resolve with trimmed stdout. */
function runBridge(args, timeout = 15_000) {
  return new Promise((resolve, reject) => {
    execFile("node", [BIN, ...args], { timeout }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim()))
      resolve(stdout.trim())
    })
  })
}

export const id = "remote-control"

export async function tui(api) {
  api.keymap.registerLayer({
    commands: [
      {
        name: "remote-control.start",
        title: "Start remote control (share this session)",
        slashName: "remote-control/start",
        category: "Remote Control",
        namespace: "palette",
        async run() {
          if (bridgeMissing()) {
            api.ui.toast({
              variant: "error",
              title: "remote-control",
              message: "bridge not installed — run: bash ~/.agents/skills/remote-control/bootstrap.sh",
              duration: 8000,
            })
            return
          }
          api.ui.toast({ variant: "info", title: "remote-control", message: "Starting…", duration: 3000 })
          try {
            const text = await startBridge()
            api.ui.dialog.replace(() =>
              api.ui.DialogAlert({
                title: "Remote control",
                message: text,
                onConfirm: () => api.ui.dialog.clear(),
              }),
            )
          } catch (err) {
            api.ui.toast({ variant: "error", title: "start failed", message: String(err?.message ?? err), duration: 8000 })
          }
        },
      },
      {
        name: "remote-control.stop",
        title: "Stop remote control",
        slashName: "remote-control/stop",
        category: "Remote Control",
        namespace: "palette",
        async run() {
          try {
            const out = await runBridge(["stop", "--relay", RELAY])
            api.ui.toast({ variant: "success", title: "remote-control", message: out || "Remote control stopped.", duration: 4000 })
          } catch (err) {
            api.ui.toast({ variant: "error", title: "stop failed", message: String(err?.message ?? err), duration: 8000 })
          }
        },
      },
      {
        name: "remote-control.status",
        title: "Remote control status",
        slashName: "remote-control/status",
        category: "Remote Control",
        namespace: "palette",
        async run() {
          try {
            const out = await runBridge(["status", "--relay", RELAY])
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
        },
      },
    ],
  })
}

export default { id, tui }
