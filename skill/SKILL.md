---
name: remote-control
description: Share the current OpenCode session on the web via the relay (opencode.b4tr.net) with a 6-character access code. Use when the user runs /remote-control start or /remote-control stop or /remote-control status, or asks to share, mirror, or remotely control this session.
---

# Remote Control

Shares the current OpenCode session on the web through the public relay (opencode.b4tr.net). A web viewer opens a short link, enters a 6-character code, and gets the official OpenCode UI bound to exactly this session.

**All communication is via the relay's HTTPS API only — never SSH.**

## Requirements

- `node` (>= 18) and `opencode` on `PATH`. No API keys, no configuration — works out of the box.
- Works in any shell and with or without the TUI: if no opencode server is listening (plain `opencode run` / `--mini` use an in-process server with no HTTP port), the bridge spawns `opencode serve` itself and ties its lifetime to the share.

## Locate the bridge

The bridge CLI lives inside this skill: `BIN="$HOME/.agents/skills/remote-control/bin/index.js"`.

If `BIN` is missing, bootstrap it once (builds the bridge from its repo and installs production deps):

```bash
bash "$HOME/.agents/skills/remote-control/bootstrap.sh"
```

## Start (`/remote-control start`)

Run in the background and keep it alive for the share's lifetime:

```bash
node "$HOME/.agents/skills/remote-control/bin/index.js" start \
  --relay https://opencode.b4tr.net > /tmp/remote-control.log 2>&1 &
```

- Port and session are auto-detected (newest ROOT session, preferring the current directory — never a subagent session).
- `relay createSession failed: 409` means the session is already registered — run the stop command first, then start again.

**Output format — report ONLY the two lines the bridge printed, nothing else (no commentary, no status, no extra text).** Read them from `/tmp/remote-control.log`:

```
https://opencode.b4tr.net/<session_id>
CODE: XXXXXX
```

The bridge exits on its own when OpenCode quits (watchdog) or on SIGINT/SIGTERM; both paths delete the relay session and revoke the code.

## Stop (`/remote-control stop`)

```bash
node "$HOME/.agents/skills/remote-control/bin/index.js" stop --relay https://opencode.b4tr.net
```

Then terminate the background bridge process (`pkill -f 'remote-control/bin/index.js'`). Stop is idempotent (an already-deleted session is not an error). Report only the bridge's output line (`Remote control stopped.`).

The session is identified automatically from the state saved by `start` (`--session-id <id>` overrides). Deleting uses the session's own bridge token saved at start — only the owner machine can stop the share.

## Status (`/remote-control status`)

```bash
node "$HOME/.agents/skills/remote-control/bin/index.js" status --relay https://opencode.b4tr.net
```

Report the output verbatim. It shows: relay health, local opencode detection, session existence, bridge connection state, viewer count, session age, title, directory.

## Security

- The access code grants full interactive control of the session — share it only with the intended viewer.
- Never log, commit, or echo the bridge token or viewer tokens.
- The code stays valid until `/remote-control stop` runs or OpenCode closes. Multiple viewers may join with the same code.
