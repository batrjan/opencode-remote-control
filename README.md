# opencode-remote-control

Share a live [OpenCode](https://github.com/anomalyco/opencode) session on the web. A local
bridge registers your session with a public relay; anyone with the 6-character access code
can watch and drive the session from a browser — full interactive control through the
official OpenCode web UI.

## Architecture

```
        Your machine                                  Relay host
┌───────────────────────────────┐      ┌──────────────────────────────────────┐
│ ┌──────────────┐  ┌────────┐  │      │  nginx (TLS via certbot)             │
│ │   OpenCode   │  │ Bridge │  │ WSS  │    └─▶ relay container (Node.js)    │
│ │ TUI + server │◀─│  CLI   │◀─┼──────┼───── WS /bridge                     │
│ │ 127.0.0.1    │  └────────┘  │      │      POST /api/sessions (public) │
│ └──────────────┘   ▲          │      │      POST /api/activate (code)      │
└────────────────────│──────────┘      │      proxied paths → WS → bridge    │
        SSE / REST   │                 │      /join · /terminal (viewer UI)  │
                     │                 │      GET /health                    │
        started by ──┘                 └──────────────────────────────────────┘
        /remote-control/start (plugin)                   ▲
                                              HTTPS      │  code → HttpOnly cookie
                                                  ┌──────┴───────┐
                                                  │ Web browser  │
                                                  │ (viewer)     │
                                                  └──────────────┘
```

The relay never sees your code: it stores only salted hashes of the access code and
tokens, rate-limits code guessing, and the proxy adapter force-binds every viewer request
to the session that issued the viewer token (allowlisted OpenCode endpoints only).

## Quick start

Prerequisites: Node.js ≥ 22 and OpenCode (TUI or CLI). No API keys, no build step.

### Install the plugin from GitHub

OpenCode has **two plugin loaders that read different files**, so register the
package in both — the terminal UI and everything else each see one of them:

`~/.config/opencode/tui.json` — the terminal UI:

```json
{
  "plugin": ["opencode-remote-control@git+https://github.com/batrjan/opencode-remote-control.git"]
}
```

`~/.config/opencode/opencode.json` — the desktop GUI, the web UI and `opencode run`:

```json
{
  "plugin": ["opencode-remote-control@git+https://github.com/batrjan/opencode-remote-control.git"]
}
```

Restart OpenCode. The plugin ships a prebuilt bridge, so no build is needed.

| Client | Loader | Config file | Entry point |
| ------ | ------ | ----------- | ----------- |
| Terminal UI (`opencode`) | TUI | `tui.json` (also `<project>/.opencode/tui.json`, `$OPENCODE_TUI_CONFIG`) | `./tui` → `plugin/remote-control.js` |
| Desktop GUI, web UI, `opencode run`, `opencode serve` | server | `opencode.json` (also `<project>/.opencode/opencode.json`, auto-discovered `.opencode/{plugin,plugins}/*.js`) | `./server` → `plugin/server.js` |

> Registering in only one file leaves the commands missing on the other side —
> the GUI has no TUI at all, so a TUI plugin can never reach it. A single module
> may export **either** `tui()` **or** `server()`, never both (the loader rejects
> a module with both), so the package ships two entry points over one shared
> implementation (`plugin/bridge-runner.js`).

Or run [`install.sh`](install.sh), which installs the plugin plus a standalone
bridge binary and registers both entries for you.

### Share the current session

In the TUI type:

```
/remote-control
```

That opens a picker with Start / Status / Stop. The actions are also direct
commands — `/remote-control/start`, `/remote-control/status`,
`/remote-control/stop` — and all four show up in the completion menu as soon
as you type `/remote`.

It prints the session URL and `CODE: XXXXXX`. Share both with your viewer — they open
the link, enter the code, and land in the OpenCode web UI proxied to your session.

Stop sharing with `/remote-control/stop`; check with `/remote-control/status`.

The bridge also stops on its own when OpenCode quits (watchdog) or on SIGINT/SIGTERM;
every stop path deletes the relay session, revokes the code, terminates the bridge
process recorded in its state file and the `opencode serve` it may have spawned.

### Surviving a bad network

A dropped connection usually does not close: it goes half-open, and both ends keep
believing the link is up while nothing crosses it. Every hop therefore has to prove
it is alive:

| Hop | Keep-alive | Env override |
| --- | ---------- | ------------ |
| bridge → relay (WS) | Pings every 20 s; an unanswered ping terminates the socket and the bridge re-dials with exponential backoff (1 s → 30 s, ±20% jitter) until it is back. A deliberate close from the relay (session stopped, credentials revoked) shuts the bridge down instead of retrying. | `REMOTE_CONTROL_WS_PING_INTERVAL_MS`, `REMOTE_CONTROL_RECONNECT_BASE_MS`, `REMOTE_CONTROL_RECONNECT_MAX_MS` |
| relay → bridge (WS) | Pings every 25 s; a bridge that misses two rounds is terminated, so its session slot is freed for the reconnect and viewer requests fail fast instead of waiting out the proxy timeout. A pong also refreshes `last_seen`, so an idle but healthy share is never reaped. | `RELAY_WS_PING_INTERVAL_MS`, `RELAY_WS_PONG_GRACE_ROUNDS` |
| relay → viewer (SSE) | A `server.heartbeat` event every 15 s, independent of bridge traffic, so intermediate proxies keep the stream open and the browser can tell a quiet session from a dead one. | `RELAY_SSE_HEARTBEAT_MS` |
| bridge → OpenCode (SSE) | Re-subscribes to `/event` when the local stream ends (server restart), so a reconnected share is never silently event-less. | `REMOTE_CONTROL_EVENT_RETRY_MS` |

In the terminal UI the TUI entry (`plugin/remote-control.js`) provides
`/remote-control` (a picker) plus `/remote-control/start`, `/remote-control/stop`
and `/remote-control/status`, running the bridge directly — no LLM prompt, instant.

In the desktop GUI, the web UI and `opencode run` the same four commands come from
the server entry (`plugin/server.js`): it registers them through the `config` hook
and runs the action itself in `command.execute.before`, so the share is started by
the plugin and the model only relays the resulting URL and code.

The TUI itself exposes no HTTP port, so the bridge starts its own
`opencode serve` against the same project and stops it again on
`/remote-control/stop`.

## Components

| Path      | What it is                                                                                  |
| --------- | ------------------------------------------------------------------------------------------- |
| `relay/`  | Public server: Express API, in-memory session store, WS bridge endpoint, proxy adapter, static viewer UI. Ships as a Docker image. |
| `bridge/` | Local CLI (`start` / `stop` / `status`) that registers the session, holds the WS to the relay, executes proxied requests against local OpenCode, and forwards SSE events. |
| `plugin/` | Two OpenCode plugin entries over one implementation: `remote-control.js` (TUI slash commands), `server.js` (desktop GUI / web UI / `opencode run`), `bridge-runner.js` (shared actions). The prebuilt bridge (`plugin/bridge/remote-control-bridge.cjs`) ships in the package — no build step. |
| `nginx/`  | Host nginx vhost (TLS termination → `127.0.0.1:8080`, authoritative `X-Forwarded-For`).      |
| `.github/workflows/deploy.yml` | Push to `main`: build relay image → GHCR → SSH deploy. See DEPLOY.md.          |

## Relay HTTP surface

| Endpoint                  | Auth                          | Purpose                                          |
| ------------------------- | ----------------------------- | ------------------------------------------------ |
| `GET /health`             | none                          | Liveness: `{ ok, healthy, sessions, version }`. Probed by the Docker HEALTHCHECK, compose, and `bridge status`. |
| `POST /api/sessions`      | public (rate-limited)      | Create a session; returns the access code + bridge token exactly once. |
| `GET /api/sessions/:id`   | public                        | Session presence check (bridge `status`).        |
| `DELETE /api/sessions/:id`| `x-bridge-token` (owner only)    | End a session; disconnects its bridge, revokes code + tokens. |
| `POST /api/activate`      | access code (rate-limited)    | Exchange a code for a viewer token; sets an HttpOnly, SameSite=Strict cookie. |
| allowlisted OpenCode paths at the root (`/session/:id/…`, `/provider`, …) | viewer cookie or `x-viewer-token` | Proxy to the bridged OpenCode; `:id` is always rewritten to the token's session. |
| `GET /event`, `GET /global/event` | viewer cookie or `x-viewer-token` | Live SSE fan-out of the session's OpenCode events, filtered to the viewer's session. Each stream reproduces OpenCode's own envelope: `/event` sends the bare event, `/global/event` wraps it as `{ directory, payload }` — the web UI reads `payload` and breaks on anything else. |
| `GET /join`, `GET /terminal` | none                       | Code-entry page and the viewer UI.               |
| `GET /api/health`         | none                          | Static `{healthy:true}` so the viewer UI selects the base-URL-prefixed API dialect. |

## Development

Node.js ≥ 22. Each package builds and tests independently:

```bash
cd relay  && npm install && npm test && npm run build   # vitest + tsc → dist/
cd bridge && npm install && npm test && npm run build
```

Relay env vars (see `relay/.env.example`): 
`PORT` (default 8080), `ACTIVATE_FAIL_DELAY_MS` (brute-force brake, default 1000),
`RELAY_WS_PING_INTERVAL_MS` / `RELAY_WS_PONG_GRACE_ROUNDS` / `RELAY_SSE_HEARTBEAT_MS`
(keep-alive, see above).

## Deployment

Push to `main` deploys automatically (build → GHCR → SSH). Server bootstrap, TLS,
nginx, and rollback: [DEPLOY.md](DEPLOY.md).

## Documentation

- Design spec (RU): [docs/superpowers/specs/2026-09-05-opencode-remote-control-design.md](docs/superpowers/specs/2026-09-05-opencode-remote-control-design.md)
- Implementation plan: [docs/superpowers/plans/2026-09-05-opencode-remote-control-plan.md](docs/superpowers/plans/2026-09-05-opencode-remote-control-plan.md)
- Deployment runbook: [DEPLOY.md](DEPLOY.md)
