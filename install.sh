#!/usr/bin/env bash
# Install the remote-control OpenCode plugin into the current user's home.
# One command, any POSIX shell with git + node + npm:
#
#   curl -fsSL <this-file-url> | bash
#
# or from a cloned repo:
#
#   bash install.sh
#
# Installs:
#   - ~/.agents/skills/remote-control/bin/          (bridge binary + bootstrap)
#   - ~/.config/opencode/remote-control/            (plugin + bundled bridge)
#   - registers the TUI entry in    ~/.config/opencode/tui.json
#   - registers the server entry in ~/.config/opencode/opencode.json
#
# NOTE: opencode has TWO plugin loaders and they read different files.
#   tui.json      → TUI plugins  → the terminal UI's slash commands
#   opencode.json → server plugins → everything without a TUI: the desktop GUI,
#                                    the web UI, `opencode run`, `opencode serve`
# Registering only one of them leaves the commands missing on the other side,
# and a single module may export either tui() or server() — never both — so the
# package ships two entry points over one shared implementation.
set -euo pipefail

REPO="${REMOTE_CONTROL_REPO:-https://github.com/batrjan/opencode-remote-control.git}"
REF="${REMOTE_CONTROL_REF:-main}"
SKILL_DIR="${HOME}/.agents/skills/remote-control"
CONFIG_DIR="${OPENCODE_CONFIG_DIR:-${HOME}/.config/opencode}"
PLUGIN_DIR="${CONFIG_DIR}/remote-control"
TUI_CONFIG="${CONFIG_DIR}/tui.json"
SERVER_CONFIG="${CONFIG_DIR}/opencode.json"
TUI_SPEC="./remote-control/remote-control.js"
SERVER_SPEC="./remote-control/server.js"

echo "Installing remote-control plugin from $REPO ($REF)…"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
git clone --depth 1 --branch "$REF" "$REPO" "$TMP/repo"

# Build the bridge (needs node + npm).
cd "$TMP/repo/bridge"
npm ci
npm run build
npm prune --omit=dev

# Install the bridge binary.
mkdir -p "$SKILL_DIR/bin" "$PLUGIN_DIR"
cp -R "$TMP/repo/bridge/dist/"* "$SKILL_DIR/bin/"
cp "$TMP/repo/bridge/package.json" "$TMP/repo/bridge/package-lock.json" "$SKILL_DIR/bin/"
cp -R "$TMP/repo/bridge/node_modules" "$SKILL_DIR/bin/"
cp "$TMP/repo/skill/bootstrap.sh" "$SKILL_DIR/bootstrap.sh" 2>/dev/null || true
chmod +x "$SKILL_DIR/bootstrap.sh" 2>/dev/null || true

# Install the native TUI plugin (slash commands run directly — no LLM),
# together with the prebuilt bridge it ships with.
cp "$TMP/repo/plugin/remote-control.js" "$PLUGIN_DIR/remote-control.js"
cp "$TMP/repo/plugin/server.js" "$PLUGIN_DIR/server.js"
cp "$TMP/repo/plugin/bridge-runner.js" "$PLUGIN_DIR/bridge-runner.js"
cp -R "$TMP/repo/plugin/bridge" "$PLUGIN_DIR/"

# Drop the pre-0.2 install location: opencode's server loader auto-discovers
# {plugin,plugins}/*.js and errors out on this tui-only module.
rm -f "${CONFIG_DIR}/plugins/remote-control.js"

# Register both entries: the TUI one in tui.json (terminal slash commands) and
# the server one in opencode.json (desktop GUI, web UI, `opencode run`).
mkdir -p "$CONFIG_DIR"
register_plugin() {
  TUI_CONFIG="$1" PLUGIN_SPEC="$2" node <<'NODE'
const fs = require("node:fs")
const file = process.env.TUI_CONFIG
const spec = process.env.PLUGIN_SPEC
let config = {}
if (fs.existsSync(file)) {
  const raw = fs.readFileSync(file, "utf8").trim()
  if (raw) {
    try {
      config = JSON.parse(raw)
    } catch (err) {
      console.error(`\n${file} is not valid JSON — add "plugin": ["${spec}"] to it by hand.`)
      process.exit(1)
    }
  }
}
const plugins = Array.isArray(config.plugin) ? config.plugin : []
if (!plugins.includes(spec)) plugins.push(spec)
config.plugin = plugins
fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n")
console.log(`registered ${spec} in ${file}`)
NODE
}
register_plugin "$TUI_CONFIG" "$TUI_SPEC"
register_plugin "$SERVER_CONFIG" "$SERVER_SPEC"

# Verify the bridge runs.
node "$SKILL_DIR/bin/index.js" --help >/dev/null

cat <<DONE

remote-control installed.

  Bridge: ~/.agents/skills/remote-control/bin/
  Plugin: ${PLUGIN_DIR}/
  Config: ${TUI_CONFIG} (terminal UI)
          ${SERVER_CONFIG} (desktop GUI, web UI, opencode run)

Restart OpenCode, then use:

  /remote-control                 (picker: start / status / stop)
  /remote-control/start | /remote-control/stop | /remote-control/status

DONE
