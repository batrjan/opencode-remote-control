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

import { readFileSync, writeSync } from "node:fs"
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
 * What `opencode run --command remote-control/start` answers instead of starting.
 *
 * The bridge follows the OpenCode process that started the share (--owner-pid)
 * and ends the share when that process exits, and `opencode run` exits right
 * after its one command. A share started there died within seconds — after the
 * terminal had printed its URL and access code, which the owner then sent to a
 * viewer who found a dead link.
 *
 * The terminal way that works is `opencode attach` to a running server: the
 * command typed there runs in that server, which stays, and the terminal draws
 * the session, where the URL and code are. This text used to recommend
 * `opencode run --attach … --command remote-control/start` instead. That starts
 * the share in the server too, but the `run --attach` client loads no plugin and
 * prints only the model's reply (on opencode 1.18.30, also with --format json),
 * so the owner saw "OK" and never the URL or code of a share that was live.
 */
const RUN_START_DECLINED = [
  "remote-control start does nothing in `opencode run`: a share ends when the",
  "OpenCode process that started it exits, and `opencode run` exits right after",
  "this command. Start it from the terminal UI, the desktop app or `opencode web`,",
  "or keep `opencode serve` running, open it with `opencode attach <server-url>`",
  "(add `--session <id>` for an existing session) and type /remote-control/start",
  "there: the share lives as long as that server, and the URL and code appear in",
  "the session. `opencode run --attach` starts a share too, but prints only the",
  "model's OK, never the URL and code.",
].join("\n")

/**
 * The instruction for the clients that show the model's reply but never the
 * command's message: `opencode --mini` (see runsMini) and ACP clients such as
 * Zed (see runsAcp). An "OK" there left the owner with no URL, no code and no
 * status, so the reply has to be the output. Only they get this: every other
 * client shows the message itself, and a model copying a share link and code
 * is one more place for them to go wrong.
 */
const REPEAT_RELAY_INSTRUCTION = [
  "The remote-control plugin already ran this command locally; its output is",
  "the message above. This client does not show that message, so reply with",
  "that output verbatim: every line exactly as written, with nothing added.",
  "Do not explain it, do not run any tools.",
].join(" ")

/**
 * How long mini's reply is held back at the end of its text (see the
 * experimental.text.complete hook). Mini ends a command's turn the moment
 * session.command answers, and draws the last line of streamed text only when
 * a turn ends; the answer came back a few milliseconds before the reply's text
 * reached mini's event stream, so the reply stayed undrawn until the next
 * prompt. A single timer tick was enough on opencode 1.18.30; this leaves a
 * wide margin and still goes unnoticed next to a model turn.
 */
const MINI_REPLY_SETTLE_MS = 250


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

/** Whether argv asks for the minimal interface (`--mini`, `--mini=…`). */
const hasMiniFlag = (argv) => argv.some((arg) => arg === "--mini" || arg.startsWith("--mini="))

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
  if (hasMiniFlag(argv)) return false
  return !argv.some((arg) => NON_TUI_SUBCOMMANDS.has(arg))
}

/**
 * Whether this process is `opencode --mini`, which runs the commands typed into
 * it itself and shows only the model's reply to them (see
 * REPEAT_RELAY_INSTRUCTION). argv alone decides, as in runPrintsReplyOnly:
 * OPENCODE_CLIENT is inherited. `opencode attach <url> --mini` is not one: its
 * commands run in the server it is attached to, which cannot tell a mini
 * client from the web UI or a full terminal UI, so they keep the plain "OK".
 */
export function runsMini(argv = process.argv.slice(2), entry = process.argv[1]) {
  if (typeof entry === "string" && TUI_WORKER_RE.test(entry)) return false
  return hasMiniFlag(argv) && !argv.some((arg) => NON_TUI_SUBCOMMANDS.has(arg))
}

/**
 * Whether this process is `opencode acp`, the agent an ACP client (Zed and other
 * editors) talks to. It runs its own server, so the commands typed in the
 * client run here, and the client shows only the model's reply to them (see
 * REPEAT_RELAY_INSTRUCTION): on opencode 1.18.30 the ACP agent streams the
 * assistant's text, tool calls and permission requests while a prompt runs,
 * but a user message's parts — the command's output — only when a thread is
 * reopened (session/load). stdout is the JSON-RPC stream and stderr the
 * editor's log, so the reply is the only way the output reaches the owner.
 *
 * The first subcommand word decides, as in runPrintsReplyOnly: `opencode acp`
 * sets OPENCODE_CLIENT=acp for itself, and every child it starts (an
 * `opencode run` in a bash tool call, a terminal UI) inherits it.
 */
export function runsAcp(argv = process.argv.slice(2)) {
  return argv.find((arg) => NON_TUI_SUBCOMMANDS.has(arg)) === "acp"
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

/** An opencode boolean flag: set when it is "1" or "true", in any case. */
const envFlag = (value) => ["1", "true"].includes(value?.toLowerCase())

/**
 * Every file the terminal UI takes plugins from, found the way TuiConfig of
 * opencode 1.18.30 finds them. Each file adds its plugins to one list, so the
 * order does not matter here. The plugin used to read only ~/.config/opencode
 * (or OPENCODE_CONFIG_DIR instead of it), <cwd>/.opencode and
 * OPENCODE_TUI_CONFIG, and so missed a TUI entry that opencode did load. The
 * server entry then registered its commands as well, and the TUI entry left
 * the slash names to them: `/remote-control` in a plain terminal UI became a
 * model turn answering "OK" instead of the picker.
 */
function tuiConfigPaths(directory, env) {
  const files = (dir) => [path.join(dir, "tui.json"), path.join(dir, "tui.jsonc")]
  const home = env.HOME || homedir()
  // The global folder: XDG_CONFIG_HOME decides, as for all of opencode's paths.
  const paths = files(path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "opencode"))
  if (env.OPENCODE_TUI_CONFIG) paths.push(env.OPENCODE_TUI_CONFIG)
  // The project: tui.json(c) and .opencode/tui.json(c) in the working directory
  // and every parent, up to the filesystem root rather than the worktree.
  if (directory && !envFlag(env.OPENCODE_DISABLE_PROJECT_CONFIG)) {
    for (let dir = path.resolve(directory); ; dir = path.dirname(dir)) {
      paths.push(...files(dir), ...files(path.join(dir, ".opencode")))
      if (path.dirname(dir) === dir) break
    }
  }
  paths.push(...files(path.join(home, ".opencode")))
  // In addition to the global folder, not instead of it.
  if (env.OPENCODE_CONFIG_DIR) paths.push(...files(env.OPENCODE_CONFIG_DIR))
  return paths
}

/**
 * Parse a config file as opencode does: JSON with comments and trailing commas.
 * Anything else malformed throws, and opencode skips such a file too.
 */
function parseJsonc(text) {
  const json = text
    // A leading UTF-8 byte order mark goes first. opencode loads a tui.json
    // that starts with one, but readFileSync keeps it as U+FEFF and JSON.parse
    // rejects that: the file was skipped, the server entry registered its
    // commands beside the TUI entry opencode did load, and `/remote-control`
    // ran a model turn instead of opening the picker.
    .replace(/^\uFEFF/, "")
    // Each comment becomes a space. A string is matched first and put back as
    // it is, so the "//" of a git+https:// plugin spec is not taken for one.
    .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_, string) => string ?? " ")
    // Then a comma that only a closing bracket follows goes, strings kept again.
    .replace(/("(?:[^"\\]|\\.)*")|,(?=\s*[}\]])/g, (_, string) => string ?? "")
  return JSON.parse(json)
}

/** Whether the TUI entry of THIS plugin is registered in a tui.json. */
export function tuiEntryRegistered(directory = process.cwd(), env = process.env) {
  for (const file of tuiConfigPaths(directory, env)) {
    let entries
    try {
      entries = parseJsonc(readFileSync(file, "utf8")).plugin
    } catch {
      // Missing, unreadable or malformed: opencode loads nothing from it either.
      // A match on the raw text used to count an entry that was commented out,
      // and the server entry stepped aside for a TUI entry that never loaded,
      // leaving the terminal UI with no /remote-control command at all.
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
  // Sessions in which a command just ran in `opencode --mini`: the next reply
  // text there is the output, and has to reach mini's screen (see
  // MINI_REPLY_SETTLE_MS).
  const settling = new Set()
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
      if (action === "start" && runPrintsReplyOnly()) {
        // Not started at all: the share would outlive this command by seconds.
        text = RUN_START_DECLINED
        // And not a success either. `opencode run` (1.18.30) exits with the
        // process.exitCode left here: it used to exit 0 with the model's "OK",
        // like a start that worked, so `… 2>share.txt && send share.txt` sent a
        // viewer this text instead of a link and code. Only this process exits:
        // with --attach the command runs in the server, where this branch never
        // fires. (Throwing instead also exits 1, but prints only "Unexpected
        // server error" and loses the text.)
        process.exitCode = 1
      } else {
        try {
          text = await run(action, input?.sessionID, { parentOf })
        } catch (err) {
          text = `remote-control ${action} failed: ${String(err?.message ?? err)}`
        }
      }
      // Mutate in place: opencode keeps a reference to this array, so a
      // reassignment would be dropped. Clearing first drops the blank command
      // template, so the visible message is exactly the plugin's output — the
      // share link and code, nothing else. The instruction rides along as a
      // synthetic part, which the model reads and the transcript hides.
      output.parts.length = 0
      output.parts.push({ type: "text", text })
      const mini = runsMini()
      // Clients that show only the reply get the output from the model instead.
      const repeat = mini || runsAcp()
      output.parts.push({ type: "text", text: repeat ? REPEAT_RELAY_INSTRUCTION : RELAY_INSTRUCTION, synthetic: true })
      // Only mini needs the reply held back: the ACP agent answers the prompt
      // after the session goes idle, once every reply delta has gone out.
      if (mini) settling.add(input?.sessionID)
      // `opencode run` prints only the model's reply — the "OK" asked for above —
      // so the owner would otherwise never learn whether a stop ended anything
      // or what URL and code a start produced.
      show(text)
    },
    // Called at the end of every text part the model writes, before the part is
    // stored as finished and the turn can end. Only the first reply text after a
    // command in `opencode --mini` waits here, briefly, so mini draws the output
    // it repeats instead of keeping it off screen until the next prompt. The
    // text itself is left alone.
    "experimental.text.complete": async (input) => {
      if (!settling.delete(input?.sessionID)) return
      await new Promise((resolve) => setTimeout(resolve, MINI_REPLY_SETTLE_MS))
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
