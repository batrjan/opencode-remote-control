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

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

import { resolveAction, runAction } from "./bridge-runner.js"

const COMMANDS = {
  "remote-control": "Share this session on the web (start | stop | status)",
  "remote-control/start": "Start remote control — share this session",
  "remote-control/stop": "Stop remote control",
  "remote-control/status": "Remote control status",
}

/** Command bodies are prompts; ours only tells the agent to relay our output. */
const TEMPLATE = [
  "The remote-control plugin already executed this command locally and put its",
  "output in this message. Repeat that output verbatim and add nothing else —",
  "do not run any tools.",
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

/** Whether this process is going to render the terminal UI. */
export function runsTui(argv = process.argv.slice(2), env = process.env) {
  const client = env.OPENCODE_CLIENT
  if (client && client !== "cli") return false
  return !argv.some((arg) => NON_TUI_SUBCOMMANDS.has(arg))
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
 * spawn the real bridge or touch the relay.
 */
export function createHooks(run = runAction, registerCommands = defaultRegisterCommands) {
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
        text = await run(action, input?.sessionID)
      } catch (err) {
        text = `remote-control ${action} failed: ${String(err?.message ?? err)}`
      }
      // Mutate in place: opencode keeps a reference to this array, so a
      // reassignment would be dropped.
      output.parts.push({ type: "text", text })
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

export async function server() {
  return createHooks()
}

export default { id, server }
