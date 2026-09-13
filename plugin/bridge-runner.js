// Shared bridge runner for the remote-control plugin.
//
// Both entry points use it: `remote-control.js` (TUI plugin, slash commands in
// the terminal UI) and `server.js` (server plugin, so the desktop GUI and
// `opencode run` get the same actions). opencode loads TUI and server plugins
// with two different loaders, and a single module may export only one of
// `tui()` / `server()` — hence two entries over one shared implementation.

import { spawn, execFile } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync } from "node:fs"
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

/**
 * How long `start` waits for the bridge to print its URL and code.
 *
 * It was 30 s, and a slow start ran past that while every stage was still
 * inside its own limit: detection, a cold `opencode serve` (up to 20 s to
 * report a port, then a health poll), the relay registration and the bridge
 * WebSocket, over owner uplinks measured at 0.7-1.7 Mbit/s. The plugin then
 * reported "timeout waiting for the bridge" while the detached bridge carried
 * on, registered the share and printed a code nobody read. Two minutes sits
 * above every bounded startup stage; what still runs past it is cancelled, not
 * abandoned (see cancelStart).
 *
 * REMOTE_CONTROL_START_TIMEOUT_MS overrides it, so a test that drives the real
 * bundle through the plugin does not wait two minutes for a cancel.
 */
export function startTimeoutMs(env = process.env) {
  const v = Number(env.REMOTE_CONTROL_START_TIMEOUT_MS)
  return Number.isFinite(v) && v > 0 ? v : 120_000
}

/** How long a cancelled bridge gets to die before its state file is read. */
const CANCEL_EXIT_WAIT_MS = 3_000

/**
 * The share a bridge registered, found by that bridge's pid in the state files
 * it writes beside the log (`<session>.json`, `pid` = the `start` process).
 * Matching the pid rather than the session id keeps an older, live share of
 * the same session out of it, and still finds the share of a start that picked
 * its own session. Undefined when that bridge registered nothing.
 */
function registeredShare(pid, dir = path.dirname(logPath())) {
  let files
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"))
  } catch {
    return undefined
  }
  for (const file of files) {
    try {
      const state = JSON.parse(readFileSync(path.join(dir, file), "utf8"))
      if (state && state.pid === pid && typeof state.session_id === "string") return state.session_id
    } catch {
      // Unreadable or half-written entry: not the one we are looking for.
    }
  }
  return undefined
}

/**
 * Take down a bridge that did not come up in time, and anything it left.
 *
 * Rejecting alone left it running: detached and unref'd, nothing else ever
 * signals it, so it went on to register the share and print a code the plugin
 * had stopped reading, with the `opencode serve` it spawned behind it. A retry
 * then hit 409 for the session and truncated the log holding that code.
 *
 * The bridge leads its own process group (spawned detached) and the server it
 * spawns stays in it, so the group is signalled: a pid-only SIGTERM killed the
 * bridge and left the server re-parented to init. Before it is up the bridge
 * has no signal handler, so SIGTERM ends it without any cleanup — hence the
 * `stop` for a share it had already registered, which deletes it on the relay
 * and clears its state. Where groups cannot be signalled (Windows) the bridge
 * pid is the fallback.
 *
 * Resolves with a sentence for the owner; never rejects.
 */
async function cancelStart(child, exited) {
  try {
    process.kill(-child.pid, "SIGTERM")
  } catch {
    try {
      child.kill("SIGTERM")
    } catch {
      // Already gone.
    }
  }
  // Read the state only once the bridge is gone, so a registration completing
  // at this very moment cannot write a state file after it was looked for.
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, CANCEL_EXIT_WAIT_MS))])
  const sessionID = registeredShare(child.pid)
  if (!sessionID) return "Nothing is shared."
  try {
    const out = await runBridge(["stop", "--relay", relayUrl(), "--session-id", sessionID])
    // `stop` says more than this only when the relay could not be told.
    return !out || out === "Remote control stopped." ? "The share it had registered was ended." : out
  } catch (err) {
    return `The share it had registered could not be ended (${String(err?.message ?? err)}) — run /remote-control/stop.`
  }
}

/** Start the bridge detached, logging to LOG; resolve once it prints URL+CODE.
 * `sessionID` pins the share to the user's current session, never another. */
function startBridge(sessionID) {
  return new Promise((resolve, reject) => {
    const bin = bridgeBin()
    if (!bin) return reject(new Error("bridge not found — install the plugin from git (see package README)"))
    const args = [bin, "start", "--relay", relayUrl()]
    if (sessionID) args.push("--session-id", sessionID)
    // This process IS the OpenCode the share was started from (TUI, desktop or
    // web server, `opencode run`). The bridge is detached below, so no signal
    // reaches it when OpenCode quits — and on the TUI path the server its
    // watchdog polls is an `opencode serve` of its own, which never goes away
    // while the bridge runs. Without the pid the share outlived OpenCode.
    args.push("--owner-pid", String(process.pid))
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
    // Watched from the start: a bridge can exit before anyone waits for it.
    const exited = new Promise((resolve) => child.on("exit", resolve))
    let settled = false
    const fail = (msg) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearInterval(poll)
      reject(new Error(msg))
    }
    const check = () => {
      let text = ""
      try {
        text = readFileSync(LOG, "utf8")
      } catch {
        return false
      }
      const { ready, failure } = parseBridgeLog(text)
      if (ready) {
        settled = true
        clearInterval(poll)
        clearTimeout(timer)
        resolve(ready)
        return true
      }
      if (failure) {
        fail(failure)
        return true
      }
      return false
    }
    const timeoutMs = startTimeoutMs()
    const timer = setTimeout(() => {
      if (settled) return
      // A code printed since the last poll still counts.
      if (check()) return
      settled = true
      clearInterval(poll)
      void cancelStart(child, exited).then((outcome) =>
        reject(
          new Error(
            `start cancelled: the bridge did not come up within ${timeoutMs / 1000} s and was stopped. ${outcome}`,
          ),
        ),
      )
    }, timeoutMs)
    const poll = setInterval(() => {
      if (settled) return clearInterval(poll)
      check()
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
  // stop/status must name the session the command was typed in, exactly like
  // start. Without an id the CLI falls back to the share that STARTED LAST, so
  // with two shares a stop typed in A ended B — and reported success while A's
  // code and viewers stayed live.
  const idArgs = sessionID ? ["--session-id", sessionID] : []
  switch (action) {
    case "start":
      return await startBridge(sessionID)
    case "stop": {
      const out = await runBridge(["stop", "--relay", relayUrl(), ...idArgs])
      // The share is down, so the URL + access code in the log are spent:
      // scrub them here rather than leaving them in the home directory until
      // some later start truncates the file. Only on success — a stop that
      // failed may have left the share (and that code) live.
      clearLog()
      return out || "Remote control stopped."
    }
    case "status":
      return (await runBridge(["status", "--relay", relayUrl(), ...idArgs], { allowFailure: true })) || "no active session"
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
