#!/usr/bin/env bash
# Install the remote-control OpenCode skill into the current user's home.
# One command, any POSIX shell with git + node + npm:
#
#   curl -fsSL <this-file-url> | bash
#
# or from a cloned repo:
#
#   bash install.sh
#
# Installs:
#   - ~/.agents/skills/remote-control/   (SKILL.md + bridge binary + bootstrap)
#   - ~/.config/opencode/commands/remote-control/  (/remote-control start|stop|status)
set -euo pipefail

REPO="${REMOTE_CONTROL_REPO:-https://github.com/batrjan/opencode-remote-control.git}"
REF="${REMOTE_CONTROL_REF:-main}"
SKILL_DIR="${HOME}/.agents/skills/remote-control"
COMMANDS_DIR="${HOME}/.config/opencode/commands/remote-control"

echo "Installing remote-control skill from $REPO ($REF)…"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
git clone --depth 1 --branch "$REF" "$REPO" "$TMP/repo"

# Build the bridge (needs node + npm).
cd "$TMP/repo/bridge"
npm ci
npm run build
npm prune --omit=dev

# Install the skill.
mkdir -p "$SKILL_DIR/bin" "$COMMANDS_DIR"
cp -R "$TMP/repo/bridge/dist/"* "$SKILL_DIR/bin/"
cp "$TMP/repo/bridge/package.json" "$TMP/repo/bridge/package-lock.json" "$SKILL_DIR/bin/"
cp -R "$TMP/repo/bridge/node_modules" "$SKILL_DIR/bin/"
cp "$TMP/repo/skill/SKILL.md" "$SKILL_DIR/SKILL.md"
cp "$TMP/repo/skill/bootstrap.sh" "$SKILL_DIR/bootstrap.sh" 2>/dev/null || true
chmod +x "$SKILL_DIR/bootstrap.sh" 2>/dev/null || true

# Install the TUI slash commands.
cp "$TMP/repo/.opencode/commands/remote-control/"*.md "$COMMANDS_DIR/"

# Verify the bridge runs.
node "$SKILL_DIR/bin/index.js" --help >/dev/null

cat <<'DONE'

remote-control installed.

  Skill:    ~/.agents/skills/remote-control/SKILL.md
  Commands: /remote-control start | stop | status

Just run in OpenCode:

  /remote-control start

DONE
