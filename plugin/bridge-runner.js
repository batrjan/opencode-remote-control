// Shared bridge runner for the remote-control plugin.
//
// Both entry points use it: `remote-control.js` (TUI plugin, slash commands in
// the terminal UI) and `server.js` (server plugin, so the desktop GUI and
// `opencode run` get the same actions). opencode loads TUI and server plugins
// with two different loaders, and a single module may export only one of
// `tui()` / `server()` — hence two entries over one shared implementation.

import { spawn, execFile } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs"
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
 * Relay text, fit for a terminal.
 *
 * Everything the plugin shows the owner is text the RELAY chose: a status
 * report repeats its `status`, `title` and `directory` fields, and a failed
 * action repeats the bridge's error line. Those went straight onto a terminal —
 * stderr in `opencode run`, a dialog or toast in the TUI — and the terminal
 * ACTED on them: a hostile relay retitled the window (`ESC]0;…BEL`), erased the
 * lines the owner had just read and forged others in their place
 * (`ESC[2K ESC[1A`), and wrote the clipboard where the terminal allows it
 * (`OSC 52`). No share of the owner's is needed: the plugin asks the relay for
 * a status even for a session it has no state for.
 *
 * So the bytes a terminal acts on are shown instead of obeyed: every C0 control
 * but newline and tab (the layout of these reports), DEL, and the C1 range
 * (`0x9b` is CSI in an 8-bit terminal).
 */
export function sanitizeForTerminal(text) {
  return String(text ?? "").replace(
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g,
    (c) => `\\x${c.codePointAt(0).toString(16).padStart(2, "0")}`,
  )
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

/**
 * Delete the bridge log after a stop, unless the access code it holds is still
 * the code of a share recorded on this machine.
 *
 * bridge.log is the log of whichever share came up LAST, and its bridge goes on
 * writing into it (how that share ended, later). The stop that ran before this
 * may have ended another share, or none: a stop typed in a session that is not
 * shared from here, or one that ended share A after share B had made its log
 * bridge.log. Clearing unconditionally deleted the URL and code of a share
 * that was still up. The code in the log names its share exactly (a share of
 * the same session started again has a new one), and the share's state file
 * (`<session>.json`, with that access_code) exists for as long as `stop` has
 * something to end — so once no recorded share holds that code, the code is
 * spent and the log goes, whichever stop got there. A log with no code in it
 * (or none that can be read) is cleared, as before.
 *
 * Same best-effort contract as clearLog: never throws; true when the log is
 * gone, false when it was kept or could not be deleted.
 */
export function clearSpentLog(file = logPath()) {
  let code
  try {
    const line = readFileSync(file, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith("CODE:"))
    code = line?.slice("CODE:".length).trim() || undefined
  } catch {
    // Missing (nothing to do) or unreadable: clearLog says which.
  }
  if (code !== undefined && recordedShares(path.dirname(file)).some((share) => share.access_code === code)) return false
  return clearLog(file)
}

/** Create the private log dir/file and return a write fd for the bridge. */
export function openLog(file = logPath()) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const fd = openSync(file, "w", 0o600)
  // openSync's mode only applies to a NEW file; tighten an existing one too.
  chmodSync(file, 0o600)
  return fd
}

let startLogCount = 0

/**
 * The log one start's bridge writes to until it is up, beside bridge.log.
 *
 * Every start used to open bridge.log itself, truncating it before the bridge
 * had even run — including a start that then failed. A second start of a share
 * that was still running got a 409 and left the log holding only that failure,
 * while the running share's URL and code were gone from it. Only a start that
 * printed its code replaces bridge.log now; a failed or cancelled one leaves it
 * as it was.
 */
function startLogPath(log) {
  return path.join(path.dirname(log), `bridge.starting-${process.pid}-${++startLogCount}.log`)
}

/** Remove a start log that will not become bridge.log. Best effort, never throws. */
function discardStartLog(file) {
  try {
    rmSync(file, { force: true })
  } catch {
    // Nothing more to do; it holds no code of a live share.
  }
}

/**
 * Where the output of the last start that failed is kept — the bridge's error
 * and the tail of a server that would not come up, which bridge.log used to
 * hold. Never a code: a start that printed one did not fail.
 */
export function failedLogPath(log = logPath()) {
  return path.join(path.dirname(log), "bridge.failed.log")
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
 * The shares recorded in the state files the bridge writes beside the log
 * (`<session>.json`), parsed. Unreadable or half-written entries are skipped;
 * an unreadable directory records nothing.
 */
function recordedShares(dir = path.dirname(logPath())) {
  let files
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"))
  } catch {
    return []
  }
  const shares = []
  for (const file of files) {
    try {
      const state = JSON.parse(readFileSync(path.join(dir, file), "utf8"))
      if (state && typeof state.session_id === "string") shares.push(state)
    } catch {
      // Unreadable or half-written entry: not a share anyone can act on.
    }
  }
  return shares
}

/**
 * The share a bridge registered, found by that bridge's pid in the state files
 * it writes beside the log (`<session>.json`, `pid` = the `start` process).
 * Matching the pid rather than the session id keeps an older, live share of
 * the same session out of it, and still finds the share of a start that picked
 * its own session. Undefined when that bridge registered nothing.
 */
function registeredShare(pid, dir = path.dirname(logPath())) {
  return recordedShares(dir).find((state) => state.pid === pid)?.session_id
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

/** Start the bridge detached, logging to a start log that becomes LOG once it
 * prints URL+CODE; resolve then. `sessionID` pins the share to the user's
 * current session, never another. */
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
    const STARTING = startLogPath(LOG)
    let out
    try {
      out = openLog(STARTING)
    } catch (err) {
      return reject(new Error(`cannot open the bridge log ${STARTING}: ${String(err?.message ?? err)}`))
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
      try {
        renameSync(STARTING, failedLogPath(LOG))
      } catch {
        discardStartLog(STARTING)
      }
      reject(new Error(msg))
    }
    const check = () => {
      let text = ""
      try {
        text = readFileSync(STARTING, "utf8")
      } catch {
        return false
      }
      const { ready, failure } = parseBridgeLog(text)
      if (ready) {
        settled = true
        clearInterval(poll)
        clearTimeout(timer)
        // The share is up: its log is now bridge.log. The bridge keeps writing
        // to the same file under the new name (how its share ended, later).
        try {
          renameSync(STARTING, LOG)
        } catch {
          // The share works regardless; its log just keeps the starting name.
        }
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
      void cancelStart(child, exited).then((outcome) => {
        // Whatever it printed belongs to a share that no longer exists.
        discardStartLog(STARTING)
        reject(
          new Error(
            `start cancelled: the bridge did not come up within ${timeoutMs / 1000} s and was stopped. ${outcome}`,
          ),
        )
      })
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


/** How many parents a stop or status climbs looking for the shared session. */
const MAX_PARENT_HOPS = 32

/**
 * How long one parent lookup may take. A stop never used to wait on the
 * OpenCode server at all; a server too busy to answer must not hang it now.
 */
const PARENT_LOOKUP_TIMEOUT_MS = 5_000

/**
 * A `parentOf(sessionID)` lookup over an OpenCode SDK client, for
 * sharedSessionOf; undefined without a client.
 *
 * The two plugin loaders hand out different SDK generations: the server
 * plugin's `input.client` takes `{ path: { id } }`, the TUI's `api.client` (v2)
 * takes `{ sessionID }`. Each ignores the other's key, so one call carries
 * both. A reply only counts when it is the session asked for, and the parent
 * only when it is a string.
 */
export function clientParentOf(client) {
  if (typeof client?.session?.get !== "function") return undefined
  return async (id) => {
    const res = await client.session.get({ sessionID: id, path: { id } })
    // `data` unless the client was built with responseStyle "data".
    const session = res?.data ?? res
    return session?.id === id && typeof session.parentID === "string" ? session.parentID : undefined
  }
}

/**
 * The session whose share a stop or status typed in `sessionID` is about: that
 * session when it is shared from this machine, else the nearest ancestor that
 * is. Undefined when neither it nor any parent is.
 *
 * Once stop and status named the session they were typed in, every session
 * without a share of its own became a dead end — including the subagent
 * sessions of a shared one, which the TUI routes into whenever the owner opens
 * a subagent. A stop typed there answered "nothing to stop" while the share it
 * belongs to (the one its viewers see it under) stayed live. A subagent session
 * is not "another share on this machine": the relay serves it as part of the
 * shared session it descends from. So the walk follows parentID up to the
 * first session with a recorded share — never sideways to an unrelated one,
 * which is what binding to the typed session was for.
 *
 * `parentOf(id)` resolves the parent id (undefined for a root). A lookup that
 * throws, loops, stalls past PARENT_LOOKUP_TIMEOUT_MS or runs deeper than
 * MAX_PARENT_HOPS ends the walk: the typed session then keeps its own answer,
 * as before.
 */
export async function sharedSessionOf(sessionID, parentOf, dir = path.dirname(logPath())) {
  const shared = new Set(recordedShares(dir).map((share) => share.session_id))
  const visited = new Set()
  let current = sessionID
  while (typeof current === "string" && current !== "" && !visited.has(current) && visited.size <= MAX_PARENT_HOPS) {
    if (shared.has(current)) return current
    if (!parentOf) return undefined
    visited.add(current)
    let timer
    try {
      current = await Promise.race([
        parentOf(current),
        new Promise((resolve) => {
          timer = setTimeout(resolve, PARENT_LOOKUP_TIMEOUT_MS, undefined)
        }),
      ])
    } catch {
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }
  return undefined
}

/**
 * The line added when a stop or status was typed where nothing is shared: which
 * sessions are shared from this machine, and where the command reaches them.
 *
 * "session … is not shared from this machine" alone left the owner with a live
 * share and no idea why stop did not end it — typed in a new session, a new
 * desktop tab, or `opencode run` (a new session every time). The share is
 * named rather than acted on: one sitting in another project may be a
 * colleague's working session, and a stop typed by mistake must not end it.
 * Oldest share first, so the list reads in the order they were started.
 */
export function sharedElsewhereHint(action, dir = path.dirname(logPath())) {
  const ids = recordedShares(dir)
    .sort((a, b) => (Number(a.started_at) || 0) - (Number(b.started_at) || 0))
    .map((share) => share.session_id)
  if (ids.length === 0) return "No session is shared from this machine."
  if (ids.length === 1) {
    return `Shared from this machine: ${ids[0]}. Run /remote-control/${action} in that session (or one of its subagents) to ${action === "stop" ? "end" : "check"} it.`
  }
  return `Shared from this machine: ${ids.join(", ")}. Run /remote-control/${action} in the session whose share you mean.`
}

/**
 * Stop the share of the session the command was typed in.
 *
 * `stopped` says whether there was a share to end. A stop typed where nothing
 * is shared exits 0 ("nothing to stop"), and the TUI used to show that as a
 * success toast while the share the owner meant stayed live; it now tells the
 * two apart, and so does the exit status of `opencode run` (server.js). Without
 * a session id (TUI home screen) the CLI falls back to the share that started
 * last and fails when there is none, so that is `stopped`.
 */
export async function stopShare(sessionID, { parentOf } = {}) {
  const shared = sessionID ? await sharedSessionOf(sessionID, parentOf) : undefined
  const target = shared ?? sessionID
  const out = await runBridge(["stop", "--relay", relayUrl(), ...(target ? ["--session-id", target] : [])])
  // A stopped share's URL + access code in the log are spent: scrub them
  // here rather than leaving them in the home directory until some later
  // start replaces the file. Only on success — a stop that failed may have
  // left the share (and that code) live. And not when the log belongs to a
  // share that is still recorded here: this stop may have ended another
  // one, or nothing at all ("not shared from this machine").
  clearSpentLog()
  const text = out || "Remote control stopped."
  if (!sessionID || shared) return { stopped: true, text }
  return { stopped: false, text: `${text}\n${sharedElsewhereHint("stop")}` }
}

/**
 * Run one action and return the text to show.
 *
 * `parentOf` (see sharedSessionOf) lets stop and status typed in a subagent
 * session reach the share that subagent belongs to; without it they act on
 * the typed session alone.
 */
export async function runAction(action, sessionID, { parentOf } = {}) {
  // stop/status must name the session the command was typed in, exactly like
  // start. Without an id the CLI falls back to the share that STARTED LAST, so
  // with two shares a stop typed in A ended B — and reported success while A's
  // code and viewers stayed live.
  switch (action) {
    case "start":
      return await startBridge(sessionID)
    case "stop":
      return (await stopShare(sessionID, { parentOf })).text
    case "status": {
      const shared = sessionID ? await sharedSessionOf(sessionID, parentOf) : undefined
      const target = shared ?? sessionID
      const out =
        (await runBridge(["status", "--relay", relayUrl(), ...(target ? ["--session-id", target] : [])], {
          allowFailure: true,
        })) || "no active session"
      return sessionID && !shared ? `${out}\n${sharedElsewhereHint("status")}` : out
    }
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
