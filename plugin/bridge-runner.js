// Shared bridge runner for the remote-control plugin.
//
// Both entry points use it: `remote-control.js` (TUI plugin, slash commands in
// the terminal UI) and `server.js` (server plugin, so the desktop GUI and
// `opencode run` get the same actions). opencode loads TUI and server plugins
// with two different loaders, and a single module may export only one of
// `tui()` / `server()` — hence two entries over one shared implementation.

import { spawn, execFile } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

/** The public relay, used when nothing overrides it. Matches the bridge CLI's own default. */
const DEFAULT_RELAY = "https://opencode.b4tr.net"

/**
 * Resolve the relay the plugin talks to.
 *
 * The bridge CLI has always taken `--relay`, but the plugin pinned the public
 * host, so a self-hosted relay was unreachable from the slash commands — the
 * one place most users ever start a share from. The value ends up on a spawned
 * command line, so it is validated rather than passed through: only http/https
 * (a `javascript:`/`file:` value would be a gift to anyone who can set the
 * environment), and trailing slashes are stripped because the bridge appends
 * its own paths (`${relay}/health`) and would otherwise build `//health`.
 *
 * Anything invalid warns and falls back — a typo in an env var must not leave
 * the user with a broken share and no explanation.
 */
export function relayUrl(env = process.env) {
  // First NON-EMPTY wins, not first non-nullish: an exported-but-empty
  // OPENCODE_REMOTE_CONTROL_RELAY ("" is a string, so `??` accepts it) would
  // otherwise shadow a perfectly good REMOTE_CONTROL_RELAY and silently route
  // the share through the public relay instead of the self-hosted one.
  const raw = [env.OPENCODE_REMOTE_CONTROL_RELAY, env.REMOTE_CONTROL_RELAY]
    .map((v) => String(v ?? "").trim())
    .find((v) => v !== "")
  if (!raw) return DEFAULT_RELAY
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    parsed = undefined
  }
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    console.warn(
      `remote-control: ignoring invalid relay ${JSON.stringify(raw)} (expected http:// or https://), using ${DEFAULT_RELAY}`,
    )
    return DEFAULT_RELAY
  }
  return raw.replace(/\/+$/, "")
}

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

/**
 * Delete the bridge log once a share is over.
 *
 * The log keeps the share URL and the `CODE: XXXXXX` line, and nothing used to
 * clear it: a code from a long-stopped session sat in the home directory until
 * the next start happened to truncate the file. Called after a successful
 * stop, so the secret's lifetime matches the share's.
 *
 * Best effort by contract — a share that ended must never report failure
 * because its log could not be deleted, so this never throws; the boolean says
 * whether the log is gone (an absent file is already gone: silent success).
 */
export function clearLog(file = logPath()) {
  try {
    rmSync(file, { force: true })
    return true
  } catch {
    return false
  }
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
    const args = [bin, "start", "--relay", relayUrl()]
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
    case "stop": {
      const out = await runBridge(["stop", "--relay", relayUrl()])
      // The share is down, so the URL + access code in the log are spent:
      // scrub them here rather than leaving them in the home directory until
      // some later start truncates the file. Only on success — a stop that
      // failed may have left the share (and that code) live.
      clearLog()
      return out || "Remote control stopped."
    }
    case "status":
      return (await runBridge(["status", "--relay", relayUrl()], { allowFailure: true })) || "no active session"
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

// `RELAY` was the pinned constant before the endpoint became configurable; it
// is kept as an alias of the default so any out-of-tree importer (the plugin
// files here use runAction, but installs copy this module around) still
// resolves. New code calls relayUrl().
export { DEFAULT_RELAY, DEFAULT_RELAY as RELAY, bridgeBin, startBridge, runBridge }
