// Shared bridge runner for the remote-control plugin.
//
// Both entry points use it: `remote-control.js` (TUI plugin, slash commands in
// the terminal UI) and `server.js` (server plugin, so the desktop GUI and
// `opencode run` get the same actions). opencode loads TUI and server plugins
// with two different loaders, and a single module may export only one of
// `tui()` / `server()` — hence two entries over one shared implementation.

import { spawn, execFile } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const RELAY = "https://opencode.b4tr.net"

/**
 * Where the bridge logs while starting — the share URL and the ACCESS CODE
 * land in this file. It used to be a fixed name in /tmp: world-readable, so
 * any other local account could read the code, and open to a symlink swap on
 * a shared machine. It now lives beside the bridge's own state, in a dir the
 * user alone can enter, and the file is opened 0600.
 */
export function logPath(env = process.env) {
  return path.join(env.HOME || homedir(), ".agents", "skills", "remote-control", "state", "bridge.log")
}

/** Create the private log dir/file and return a write fd for the bridge. */
export function openLog(file = logPath()) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const fd = openSync(file, "w", 0o600)
  // openSync's mode only applies to a NEW file; tighten an existing one too.
  chmodSync(file, 0o600)
  return fd
}

// The bridge CLI ships prebuilt INSIDE this package (bridge/remote-control-bridge.cjs)
// so the plugin works straight from a git/npm install — no local build step.
const PKG_ROOT = path.dirname(fileURLToPath(import.meta.url))
const BUNDLED_BIN = path.join(PKG_ROOT, "bridge", "remote-control-bridge.cjs")
// Fallback for the classic skill layout (installed by install.sh).
const SKILL_BIN = path.join(homedir(), ".agents", "skills", "remote-control", "bin", "index.js")

function bridgeBin() {
  if (existsSync(BUNDLED_BIN)) return BUNDLED_BIN
  if (existsSync(SKILL_BIN)) return SKILL_BIN
  return undefined
}

/**
 * Read the share URL + access code out of the bridge log.
 *
 * The bridge may spawn its own `opencode serve` (the TUI has no HTTP port),
 * and that server logs into the same file — so the URL/CODE pair is NOT
 * simply the first two lines, and a server log line mentioning "error" is not
 * a bridge failure. Exported for tests.
 *
 * @returns `ready` — the two lines to show, once the code is printed;
 *          `failure` — the bridge's own error line, if it failed instead.
 */
export function parseBridgeLog(text) {
  const lines = String(text ?? "")
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
  const codeIndex = lines.findIndex((l) => l.startsWith("CODE:"))
  if (codeIndex !== -1) {
    const url = lines
      .slice(0, codeIndex)
      .reverse()
      .find((l) => /^https?:\/\//.test(l))
    return { ready: [url, lines[codeIndex]].filter(Boolean).join("\n"), failure: undefined }
  }
  const failure = lines.find((l) => /^(bridge \w+ failed|error:)/i.test(l))
  return { ready: undefined, failure }
}

/** Start the bridge detached, logging to LOG; resolve once it prints URL+CODE.
 * `sessionID` pins the share to the user's current session, never another. */
function startBridge(sessionID) {
  return new Promise((resolve, reject) => {
    const bin = bridgeBin()
    if (!bin) return reject(new Error("bridge not found — install the plugin from git (see package README)"))
    const args = [bin, "start", "--relay", RELAY]
    if (sessionID) args.push("--session-id", sessionID)
    const LOG = logPath()
    let out
    try {
      out = openLog(LOG)
    } catch (err) {
      return reject(new Error(`cannot open the bridge log ${LOG}: ${String(err?.message ?? err)}`))
    }
    const child = spawn("node", args, {
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
      const { ready, failure } = parseBridgeLog(text)
      if (ready) {
        settled = true
        clearInterval(poll)
        clearTimeout(timer)
        resolve(ready)
      } else if (failure) {
        fail(failure)
      }
    }, 250)
    child.on("error", (err) => fail(String(err)))
  })
}

/** Run a short-lived bridge subcommand; resolve with trimmed stdout. */
function runBridge(args, { timeout = 15_000, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const bin = bridgeBin()
    if (!bin) return reject(new Error("bridge not found — install the plugin from git (see package README)"))
    execFile("node", [bin, ...args], { timeout }, (err, stdout, stderr) => {
      const out = String(stdout ?? "").trim()
      // `status` reports "not sharing" with a non-zero exit code — that is a
      // result, not a crash, so keep its report instead of raising.
      if (err && !(allowFailure && out)) return reject(new Error((stderr || err.message).trim()))
      resolve(out)
    })
  })
}


/** Run one action and return the text to show. */
export async function runAction(action, sessionID) {
  switch (action) {
    case "start":
      return await startBridge(sessionID)
    case "stop":
      return (await runBridge(["stop", "--relay", RELAY])) || "Remote control stopped."
    case "status":
      return (await runBridge(["status", "--relay", RELAY], { allowFailure: true })) || "no active session"
    default:
      throw new Error(`unknown action: ${action} (use start, stop or status)`)
  }
}

/** Parse the action out of a slash command name plus its arguments. */
export function resolveAction(command, args) {
  const fromName = String(command ?? "")
    .split("/")
    .pop()
    .trim()
  if (ACTIONS.has(fromName)) return fromName
  const fromArgs = String(args ?? "")
    .trim()
    .split(/\s+/)[0]
  if (ACTIONS.has(fromArgs)) return fromArgs
  return "status"
}

const ACTIONS = new Set(["start", "stop", "status"])

export { RELAY, bridgeBin, startBridge, runBridge }
