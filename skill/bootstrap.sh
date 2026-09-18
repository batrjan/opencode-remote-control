#!/usr/bin/env bash
# Bootstrap the remote-control bridge into this skill's bin/ directory.
# Works in any POSIX shell with node + npm available. Idempotent.
set -euo pipefail

SKILL_DIR="${REMOTE_CONTROL_HOME:-${HOME}}/.agents/skills/remote-control"
BIN_DIR="${SKILL_DIR}/bin"
REPO="${REMOTE_CONTROL_REPO:-https://github.com/batrjan/opencode-remote-control.git}"
REF="${REMOTE_CONTROL_REF:-main}"

mkdir -p "$BIN_DIR"

# If the bridge is already built and runnable, nothing to do.
if [ -f "$BIN_DIR/index.js" ] && [ -d "$BIN_DIR/node_modules/commander" ]; then
  echo "remote-control bridge already installed at $BIN_DIR"
  exit 0
fi

echo "Bootstrapping remote-control bridge from $REPO ($REF)…"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

git clone --depth 1 --branch "$REF" "$REPO" "$TMP/repo"
cd "$TMP/repo/bridge"
npm ci
npm run build
npm prune --omit=dev

# Ship the compiled entrypoint + production deps only.
cp -R dist/* "$BIN_DIR/"
cp package.json package-lock.json "$BIN_DIR/"
cp -R node_modules "$BIN_DIR/"

echo "remote-control bridge installed at $BIN_DIR"
node "$BIN_DIR/index.js" --help >/dev/null && echo "OK: bridge runs"
