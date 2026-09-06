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
#   - ~/.agents/skills/remote-control/bin/   (bridge binary + bootstrap)
#   - ~/.config/opencode/plugins/remote-control.js  (native slash commands)
set -euo pipefail

REPO="${REMOTE_CONTROL_REPO:-https://github.com/batrjan/opencode-remote-control.git}"
REF="${REMOTE_CONTROL_REF:-main}"
SKILL_DIR="${HOME}/.agents/skills/remote-control"
PLUGINS_DIR="${HOME}/.config/opencode/plugins"

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
mkdir -p "$SKILL_DIR/bin" "$PLUGINS_DIR"
cp -R "$TMP/repo/bridge/dist/"* "$SKILL_DIR/bin/"
cp "$TMP/repo/bridge/package.json" "$TMP/repo/bridge/package-lock.json" "$SKILL_DIR/bin/"
cp -R "$TMP/repo/bridge/node_modules" "$SKILL_DIR/bin/"
cp "$TMP/repo/skill/bootstrap.sh" "$SKILL_DIR/bootstrap.sh" 2>/dev/null || true
chmod +x "$SKILL_DIR/bootstrap.sh" 2>/dev/null || true

# Install the native TUI plugin (slash commands run directly — no LLM).
cp "$TMP/repo/plugin/remote-control.js" "$PLUGINS_DIR/remote-control.js"

# Verify the bridge runs.
node "$SKILL_DIR/bin/index.js" --help >/dev/null

cat <<'DONE'

remote-control installed.

  Bridge: ~/.agents/skills/remote-control/bin/
  Plugin: ~/.config/opencode/plugins/remote-control.js

Restart OpenCode, then use:

  /remote-control start | stop | status

DONE
