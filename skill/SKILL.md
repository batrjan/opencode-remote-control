---
name: remote-control
description: Share the current OpenCode session on the web via the relay (opencode.b4tr.net) with a 6-character access code. Use when the user runs /remote-control start or /remote-control stop, or asks to share, mirror, or remotely control this session.
---

# Remote Control

Runs the local bridge (`bridge/` in this repo) between the OpenCode server and the public relay, so a web viewer at `https://opencode.b4tr.net/join` can watch and drive this session with a short access code.

## Prerequisites

- `RELAY_API_KEY` must be in the environment. If it is missing, ask the user — never invent or hardcode it.
- Build the bridge once per checkout: `cd bridge && npm install && npm run build`.
- Invoke the CLI as `node <repo>/bridge/dist/index.js` (or `npx bridge` when the package is linked onto PATH — the name `bridge` on the public npm registry is a different package, so do NOT install it from there).

## Start (`/remote-control start`)

1. Run in the background and keep it alive for the share's lifetime:

   `node bridge/dist/index.js start --relay https://opencode.b4tr.net --api-key $RELAY_API_KEY`

   - Port and session are auto-detected (newest session, preferring the current directory); `--port <n>` and `--session-id <id>` override.
   - `relay createSession failed: 409` means this session is already registered — run the stop command first, then start again.
2. The output contains `Access code: XXXXXX` and `Viewer URL: https://opencode.b4tr.net/join`. Show both to the user verbatim — the code is displayed only once and is the viewer's only credential.
3. The bridge exits on its own when OpenCode quits (watchdog) or on SIGINT/SIGTERM; both paths delete the relay session and revoke the code.

## Stop (`/remote-control stop`)

1. Run: `node bridge/dist/index.js stop --relay https://opencode.b4tr.net --api-key $RELAY_API_KEY --session-id <current>`
2. If the background bridge process from start is still running, terminate it too. Stop is idempotent (an already-deleted session is not an error).

## Status

`node bridge/dist/index.js status --relay https://opencode.b4tr.net --api-key $RELAY_API_KEY --session-id <id>` — probes relay health, local OpenCode detection, and whether the session is still registered. Use it when the user reports the viewer page is stale or the code stopped working.

## Security

- The access code grants full interactive control of the session — share it only with the intended viewer.
- Never log, commit, or echo `RELAY_API_KEY` or the bridge token.
