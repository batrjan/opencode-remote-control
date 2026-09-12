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

The relay holds no plaintext secrets: it stores only salted hashes of the access code and
of every token, rate-limits code guessing, and the proxy adapter force-binds each viewer
request to the session that issued the viewer token (allowlisted OpenCode endpoints only).
What it does *not* do is limit a viewer to looking — see below.

## What sharing grants

A share is **full interactive control of the session**, not a read-only view. The proxy
allowlist is the surface the official OpenCode web UI drives, and that surface writes:
anyone holding the link *and* the code acts on the machine running OpenCode, as you.

| A viewer can | Through |
| ------------ | ------- |
| Run arbitrary shell commands in the project | `POST /session/:id/shell`, `POST /session/:id/command` |
| Start arbitrary agent turns — editing files, running tools, spending your model credits | `POST /session/:id/message`, `POST /session/:id/prompt_async` |
| Read and search any file the project can reach | `GET /file/content`, `GET /find`, `GET /find/file`, `GET /find/symbol` |
| Answer permission prompts raised by that session | `POST /session/:id/permissions/:permissionID` |

So the access code is a credential to the project directory. Hand it only to someone you
would let sit at your keyboard, and stop the share when they are done.

| What protects the share | Detail |
| ----------------------- | ------ |
| Access code | 6 characters from a 34-symbol alphabet (`A–Z0–9` minus `O` and `I`) ≈ 30 bits. Small enough that it only holds up because guessing is throttled. |
| Per-session lockout | **Five wrong codes in a row against one share lock activation for it for 15 minutes**, wherever the attempts came from. Counted per session, not per address, because an address costs nothing to change and a grind is simply spread across many; the share is the one thing an attacker cannot swap. Counted *consecutively*, so anyone getting in clears the run — a colleague's typo is forgotten the moment somebody joins. That caps guessing at 480 attempts a day against ~1.5 billion codes: on the order of 4,400 years to an even chance. While locked, activation is refused for everyone including a correct code — admitting it would let a distributed attacker keep guessing at full speed and win on a lucky try, which is exactly what the lock prevents. A specific wrong code is refused outright after 3 repeats. |
| No per-address limit on guesses | Deliberate. It throttled colleagues behind one office NAT — the sixth person with a perfectly good code was told "too many attempts" — while the attacker it was aimed at just changed address. `RELAY_TRUST_PROXY` still matters, because registration caps (12/hour, 5 active shares per address) do key on the client address; see [DEPLOY.md](DEPLOY.md). nginx also rate-limits the endpoint at the edge. |
| Wrong-code delay | Every rejected code is answered after a ~1 s delay (`ACTIVATE_FAIL_DELAY_MS`), so each guess costs real time. |
| Forced session binding | The proxy routes only allowlisted paths and rewrites the `:id` in every one of them to the token's own session, so a viewer can never reach another share (subagent sessions of the shared one stay readable — they belong to it). The bridge re-checks each forwarded path against its own allowlist before touching OpenCode. |
| Viewer tokens | HttpOnly, `SameSite=Strict`, `Secure` cookie; salted-hashed at the relay; expire after 24 h of inactivity (sliding) and capped at 32 per session. At the cap only an *idle* seat is reclaimed — a viewer seen in the last 5 minutes is never displaced, and a genuinely full share tells the next person so instead of quietly taking someone's place. |
| Viewer mint rate | A session accepts at most 64 successful activations per 10 minutes, whoever presents the code. It bounds how fast tokens can be minted; it is deliberately far above a real team, because a room of colleagues joining and one machine churning tokens look identical by volume — the seat rule above is what protects the people already in. |
| Transport and storage | TLS terminates at nginx; the persisted session set is encrypted at rest (AES-256-GCM) with a key kept off the state volume. |

What it does **not** protect against:

- **Someone you gave the code to.** There is no per-viewer identity, no read-only mode and
  no per-person audit trail. Sharing is trusting; the only revocation is ending the share.
- **A compromised relay host.** It keeps no plaintext secrets, but it mints the access code
  and routes every proxied request, so it sees a live share's traffic — prompts, command
  output, any file a viewer opens — and can issue requests of its own. The bridge's own path
  allowlist is the defense-in-depth here: anything outside it is refused with a 403, so a
  hostile relay reaches no more of the OpenCode API than a viewer already can. It cannot
  make that surface harmless — the surface runs commands.

Ending a share: `/remote-control/stop` (deletes the relay session, revokes the code and
every viewer token, and disconnects the bridge), quitting OpenCode (the watchdog does the
same), or leaving it alone — the relay reaps a session after 24 h without bridge traffic.

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
| relay restart | The session set is persisted, encrypted at rest (AES-256-GCM) with a key kept off the state volume, so redeploying the relay no longer ends live shares: the bridge reconnects, viewers' cookies still work, and unused join codes keep working too. A stolen copy of the volume is useless without the key. | `RELAY_STATE_FILE`, `RELAY_STATE_KEY` |

A share that really is gone (stopped, or aged out) answers with a page saying
so and how to get a new link, instead of a bare 404.

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

### What "live" covers, and what it does not

OpenCode's event stream is per **process**. The bridge forwards the `/event`
stream of the server it is attached to, so a viewer sees, live:

- everything the viewer themselves does (their prompts run through that server),
- everything anyone does through that same server — including another viewer.

It does **not** see work the owner does in a *different* OpenCode process. On
the TUI path that is the owner's own typing: the TUI has no HTTP port, so the
bridge spawns a second `opencode serve`, and the two processes share the
session database but not an event bus. Measured directly: a message written by
a separate process lands in the session (a viewer's next fetch returns it) while
the bridge's `/event` stream carries nothing but heartbeats for it. The viewer's
UI therefore shows the owner's new messages only after a reload.

If you want the owner's own turns mirrored live, share from a process that
*is* the server — `opencode serve` (or the desktop GUI) plus
`opencode attach <url>` for the owner's terminal — so both ends drive the same
instance. Driving a session from the browser works fully either way.

## Components

| Path      | What it is                                                                                  |
| --------- | ------------------------------------------------------------------------------------------- |
| `relay/`  | Public server: Express API, in-memory session store, WS bridge endpoint, proxy adapter, static viewer UI. Ships as a Docker image. |
| `bridge/` | Local CLI (`start` / `stop` / `status`) that registers the session, holds the WS to the relay, executes proxied requests against local OpenCode (only those on its own path allowlist), and forwards SSE events. |
| `plugin/` | Two OpenCode plugin entries over one implementation: `remote-control.js` (TUI slash commands), `server.js` (desktop GUI / web UI / `opencode run`), `bridge-runner.js` (shared actions). The prebuilt bridge (`plugin/bridge/remote-control-bridge.cjs`) ships in the package — no build step. |
| `nginx/`  | Host nginx vhost (TLS termination → `127.0.0.1:8080`, authoritative `X-Forwarded-For`).      |
| `.github/workflows/deploy.yml` | Push to `main`: run the test suites → ship `relay/` over SSH → build and restart on the host → health check (or automatic rollback). See DEPLOY.md. |

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

Request sizes are capped per side, because the two sides want opposite things: the
unauthenticated JSON API (`POST /api/sessions`, `POST /api/activate`) accepts at most
**32 KB**, while authenticated proxy traffic gets **25 MB** so a viewer can paste a whole
file into a prompt. The proxy's parser is mounted behind the viewer check, so an anonymous
request can never make the relay buffer the larger limit. Anything over the cap gets
`413 {"error":"payload too large"}`.

## Development

Node.js ≥ 22. Each package builds and tests independently:

```bash
cd relay  && npm install && npm test && npm run build   # vitest + tsc → dist/
cd bridge && npm install && npm test && npm run build
```

Env vars (relay defaults also in `relay/.env.example`):

| Var | Side | Effect |
| --- | ---- | ------ |
| `PORT` | relay | Listen port (default 8080). |
| `ACTIVATE_FAIL_DELAY_MS` | relay | Delay before a wrong access code is rejected (brute-force brake, default 1000). |
| `RELAY_WS_PING_INTERVAL_MS`, `RELAY_WS_PONG_GRACE_ROUNDS`, `RELAY_SSE_HEARTBEAT_MS` | relay | Keep-alive tuning — see the table above. |
| `RELAY_STATE_FILE`, `RELAY_STATE_KEY` | relay | Where the session set is persisted, and the key it is encrypted with. Empty path = in-memory only. |
| `RELAY_TRUST_PROXY` | relay | Which proxy hop's `X-Forwarded-For` to believe. Every per-IP limit keys on it, so a wrong value makes them global — see [DEPLOY.md](DEPLOY.md). |
| `OPENCODE_REMOTE_CONTROL_RELAY`, `REMOTE_CONTROL_RELAY` | plugin, bridge | Point the slash commands at a self-hosted relay instead of the public one (`https://opencode.b4tr.net`); the first set wins. The value reaches a spawned command line, so it must parse as `http://` or `https://` — anything else warns and falls back to the default; trailing slashes are stripped. |
| `REMOTE_CONTROL_WS_PING_INTERVAL_MS`, `REMOTE_CONTROL_RECONNECT_BASE_MS`, `REMOTE_CONTROL_RECONNECT_MAX_MS`, `REMOTE_CONTROL_EVENT_RETRY_MS` | bridge | Keep-alive tuning — see the table above. |
| `REMOTE_CONTROL_ALLOW_ANY_PATH=1` | bridge | Escape hatch: turns off the bridge's own path allowlist (it warns once, loudly), so the bridge runs whatever method and path the relay sends. This removes a safety net and exists only so an older bridge can still serve a newer relay that added a route. Leave it unset. |

## Deployment

Push to `main` deploys automatically: the tests run first, the build context is shipped
over SSH, the host builds the image and restarts the relay, and a container that fails its
health check is rolled back to the previously tagged image. Server bootstrap, TLS, nginx
and manual rollback: [DEPLOY.md](DEPLOY.md).

## Documentation

- Design spec (RU): [docs/superpowers/specs/2026-09-05-opencode-remote-control-design.md](docs/superpowers/specs/2026-09-05-opencode-remote-control-design.md)
- Implementation plan: [docs/superpowers/plans/2026-09-05-opencode-remote-control-plan.md](docs/superpowers/plans/2026-09-05-opencode-remote-control-plan.md)
- Deployment runbook: [DEPLOY.md](DEPLOY.md)
