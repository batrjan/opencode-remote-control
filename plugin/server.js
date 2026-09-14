// remote-control SERVER plugin for OpenCode.
//
// The terminal UI gets its slash commands from the TUI entry (./tui). The
// desktop GUI, `opencode run` and any headless server have no TUI at all, so
// they need this entry: it registers the same /remote-control command through
// the config hook and executes it locally in `command.execute.before`, so the
// share starts from the plugin — not from an LLM deciding to run something.
//
// Install from git: add to ~/.config/opencode/opencode.json →
//   "plugin": ["opencode-remote-control@git+https://github.com/batrjan/opencode-remote-control.git"]
//
// A module may export EITHER server() or tui(), never both — the two live in
// separate files and share plugin/bridge-runner.js.

import { existsSync, readFileSync, writeSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

import { clientParentOf, resolveAction, runAction } from "./bridge-runner.js"

const COMMANDS = {
  "remote-control": "Share this session on the web (start | stop | status)",
  "remote-control/start": "Start remote control — share this session",
  "remote-control/stop": "Stop remote control",
  "remote-control/status": "Remote control status",
}

/**
 * Command bodies are prompts, and opencode REQUIRES one — a server-plugin
 * command always produces a model turn, with no supported way to suppress it
 * (Command.template is mandatory; command.execute.before can only edit parts).
 *
 * The body is therefore blank and gets replaced at execute time. It used to
 * carry the instruction below, which rode along as a SECOND visible message
 * part: users saw "The remote-control plugin already executed this command…"
 * in the chat instead of their share link, and the model sometimes echoed that
 * instruction rather than the output.
 */
const TEMPLATE = " "

/**
 * Sent as a `synthetic` part: the model reads it, the transcript does not show
 * it. Without any instruction the model treats a bare share link as a riddle
 * and answers "what would you like me to do?" — with it, the turn is a silent
 * acknowledgement and the user just sees their link and code.
 */
const RELAY_INSTRUCTION = [
  "The remote-control plugin already ran this command locally; its output is",
  "the message above. Reply with exactly the single word OK. Do not repeat the",
  "output, do not explain it, do not run any tools.",
].join(" ")


/**
 * Subcommands that never open a terminal UI. `opencode` with none of them (or
 * with just a project path) starts the TUI; `OPENCODE_CLIENT` is "desktop" in
 * the GUI and "acp" under ACP — both have no TUI either.
 */
const NON_TUI_SUBCOMMANDS = new Set([
  "serve", "run", "web", "attach", "acp", "mcp", "github", "pr", "session", "export", "import",
  "models", "stats", "db", "upgrade", "uninstall", "providers", "auth", "agent", "plugin",
  "completion", "debug",
])

/**
 * The script the terminal UI runs its server side in. opencode starts it as a
 * worker, so there process.argv is ["bun", "/$bunfs/root/src/cli/tui/worker.js"]
 * and carries none of the command line.
 */
const TUI_WORKER_RE = /[\\/]cli[\\/]tui[\\/]worker\.js$/

/**
 * Whether this process is going to render the terminal UI.
 *
 * The TUI worker is recognised first, by its entry script: OPENCODE_CLIENT is
 * inherited, so a TUI started from a terminal inside the desktop app carries
 * OPENCODE_CLIENT=desktop and would otherwise be taken for the desktop sidecar
 * (which also has no subcommand), and its commands registered twice.
 */
export function runsTui(argv = process.argv.slice(2), env = process.env, entry = process.argv[1]) {
  if (typeof entry === "string" && TUI_WORKER_RE.test(entry)) return true
  const client = env.OPENCODE_CLIENT
  if (client && client !== "cli") return false
  // `--mini` draws its interface from the main thread and loads no tui.json
  // plugin, so the config commands are the only ones it gets.
  if (argv.some((arg) => arg === "--mini" || arg.startsWith("--mini="))) return false
  return !argv.some((arg) => NON_TUI_SUBCOMMANDS.has(arg))
}

/**
 * Whether this process is `opencode run`, whose terminal never shows the
 * command's message. Its event loop prints only finished text parts
 * (`time.end`) — the model's reply — and the user message carrying the output
 * has none, so `opencode run --command remote-control/stop` printed just the
 * model's "OK", whether the share ended, there was nothing to stop, or the stop
 * failed. The first subcommand word decides. With `--attach` the command runs
 * in the attached server, never in this process, so nothing is printed here.
 *
 * argv alone decides, unlike runsTui: OPENCODE_CLIENT is inherited. The desktop
 * app sets it for itself, so a `run` typed into a terminal the app opened
 * carries OPENCODE_CLIENT=desktop and still prints only the reply. argv already
 * rules out everything that must stay quiet — the TUI, `serve`/`web`, `acp`,
 * and the desktop sidecar, which is started with no subcommand at all.
 */
export function runPrintsReplyOnly(argv = process.argv.slice(2)) {
  return argv.find((arg) => NON_TUI_SUBCOMMANDS.has(arg)) === "run"
}

/**
 * Put the command's output on the terminal of an `opencode run`. stderr, not
 * stdout: stdout carries the model's reply, or the event stream a
 * `--format json` consumer parses line by line, and stderr is where `run`
 * prints its own lines (`> build · model`). The terminal UI (whose screen this
 * would scribble over) and servers (whose clients show the message; their
 * stderr is a service log) get nothing.
 */
export function showInRunTerminal(text) {
  if (!runPrintsReplyOnly()) return
  // Synchronously, on the descriptor: process.stderr.write reports a closed
  // pipe (EPIPE) as an asynchronous 'error' event that no try/catch sees, and
  // it turned `opencode run` into exit 1 after the command had already done its
  // work — a script whose `&& echo stopped` then read a stopped share as a
  // failed stop.
  writeAllSync(2, Buffer.from(`${text}\n`))
}

/**
 * Write all of `buf` to `fd`, best effort, never for longer than `deadlineMs`.
 *
 * A piped stderr is non-blocking inside `opencode run`: one writeSync stores at
 * most what fits in the pipe and returns, or throws EAGAIN when the pipe is
 * full. So keep writing, and wait briefly for the reader while the pipe is
 * full — but only up to the deadline, so a stderr nobody reads cannot hang the
 * command. Any other error (a closed pipe, a closed descriptor) ends the write
 * quietly: the session keeps its message either way. Returns the bytes written.
 */
export function writeAllSync(fd, buf, deadlineMs = 2000) {
  const deadline = Date.now() + deadlineMs
  let off = 0
  while (off < buf.length) {
    try {
      off += writeSync(fd, buf, off)
      continue
    } catch (err) {
      if (err?.code !== "EAGAIN" || Date.now() >= deadline) return off
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
  }
  return off
}

/** Config files the TUI plugin loader reads, most specific last. */
function tuiConfigPaths(directory, env) {
  const configDir = env.OPENCODE_CONFIG_DIR || path.join(env.HOME || homedir(), ".config", "opencode")
  const paths = [path.join(configDir, "tui.json"), path.join(configDir, "tui.jsonc")]
  if (directory) paths.push(path.join(directory, ".opencode", "tui.json"), path.join(directory, ".opencode", "tui.jsonc"))
  if (env.OPENCODE_TUI_CONFIG) paths.push(env.OPENCODE_TUI_CONFIG)
  return paths
}

/** Whether the TUI entry of THIS plugin is registered in a tui.json. */
export function tuiEntryRegistered(directory = process.cwd(), env = process.env) {
  for (const file of tuiConfigPaths(directory, env)) {
    if (!file || !existsSync(file)) continue
    let raw
    try {
      raw = readFileSync(file, "utf8")
    } catch {
      continue
    }
    let entries
    try {
      entries = JSON.parse(raw).plugin
    } catch {
      // jsonc / malformed: fall back to a text match rather than guessing.
      if (/remote-control/.test(raw)) return true
      continue
    }
    if (Array.isArray(entries) && entries.some((e) => /remote-control/.test(String(Array.isArray(e) ? e[0] : e)))) {
      return true
    }
  }
  return false
}

export const id = "remote-control"

/**
 * Hooks factory. `run` is the action runner — injected in tests so they never
 * spawn the real bridge or touch the relay. `parentOf` resolves a session's
 * parent (see sharedSessionOf), so stop and status typed in a subagent session
 * reach the share it belongs to; without it they act on the typed session only.
 * `show` gets the output as well, for a client that never displays the message
 * (see showInRunTerminal).
 */
export function createHooks(
  run = runAction,
  registerCommands = defaultRegisterCommands,
  parentOf = undefined,
  show = showInRunTerminal,
) {
  return {
    // Register the commands so they appear in the `/` menu of every client
    // that has no TUI plugin support (desktop GUI, web UI).
    config: async (config) => {
      // In a terminal-UI process the TUI entry registers the same names as
      // native, LLM-free commands. Registering them here too would show every
      // one of them twice in the `/` menu, so step aside — but only when that
      // entry is actually installed, otherwise the TUI would end up with no
      // commands at all.
      if (!registerCommands()) return
      config.command ??= {}
      for (const [name, description] of Object.entries(COMMANDS)) {
        config.command[name] ??= { description, template: TEMPLATE }
      }
    },
    // Run the action here, before the model sees anything, and hand the result
    // back as the message body. The bridge is started by the plugin itself, so
    // the behaviour matches the TUI exactly.
    "command.execute.before": async (input, output) => {
      const name = String(input?.command ?? "")
      if (name !== "remote-control" && !name.startsWith("remote-control/")) return
      const action = resolveAction(name, input?.arguments)
      let text
      try {
        text = await run(action, input?.sessionID, { parentOf })
      } catch (err) {
        text = `remote-control ${action} failed: ${String(err?.message ?? err)}`
      }
      // Mutate in place: opencode keeps a reference to this array, so a
      // reassignment would be dropped. Clearing first drops the blank command
      // template, so the visible message is exactly the plugin's output — the
      // share link and code, nothing else. The instruction rides along as a
      // synthetic part, which the model reads and the transcript hides.
      output.parts.length = 0
      output.parts.push({ type: "text", text })
      output.parts.push({ type: "text", text: RELAY_INSTRUCTION, synthetic: true })
      // `opencode run` prints only the model's reply — the "OK" asked for above —
      // so the owner would otherwise never learn whether a stop ended anything
      // or what URL and code a start produced.
      show(text)
    },
  }
}

/**
 * Register the config commands unless a terminal UI in this very process will
 * register the same names natively through the TUI entry.
 */
export function defaultRegisterCommands() {
  return !(runsTui() && tuiEntryRegistered())
}

// opencode passes the plugin input (with the SDK `client` of this server); an
// older host or a test that passes nothing still gets working hooks.
export async function server(input) {
  return createHooks(runAction, defaultRegisterCommands, clientParentOf(input?.client))
}

export default { id, server }
