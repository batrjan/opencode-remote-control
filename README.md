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
└────────────────────│──────────┘      │      /api/opencode/* → WS → bridge  │
        SSE / REST   │                 │      /join · /terminal (viewer UI)  │
                     │                 │      GET /health                    │
        started by ──┘                 └──────────────────────────────────────┘
        /remote-control start (plugin)                   ▲
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

Add to your `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["opencode-remote-control@git+https://github.com/batrjan/opencode-remote-control.git"]
}
```

Restart OpenCode. The plugin ships a prebuilt bridge, so no build is needed.

### Share the current session

In the TUI run:

```
/remote-control start
```

It prints the session URL and `CODE: XXXXXX`. Share both with your viewer — they open
the link, enter the code, and land in the OpenCode web UI proxied to your session.

Stop sharing with `/remote-control stop`; check with `/remote-control status`.

The bridge also stops on its own when OpenCode quits (watchdog) or on SIGINT/SIGTERM;
every stop path deletes the relay session and revokes the code.

In the OpenCode TUI, the native plugin (`plugin/remote-control.js`, installed to
`~/.config/opencode/plugins/`) provides `/remote-control start|stop|status` — slash
commands run the bridge directly (no LLM prompt, instant).

## Components

| Path      | What it is                                                                                  |
| --------- | ------------------------------------------------------------------------------------------- |
| `relay/`  | Public server: Express API, in-memory session store, WS bridge endpoint, proxy adapter, static viewer UI. Ships as a Docker image. |
| `bridge/` | Local CLI (`start` / `stop` / `status`) that registers the session, holds the WS to the relay, executes proxied requests against local OpenCode, and forwards SSE events. |
| `plugin/` | Native TUI plugin: slash commands run the bridge directly (no LLM). The prebuilt bridge (`plugin/bridge/remote-control-bridge.cjs`) ships in the package — no build step. |
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
| `/api/opencode/*`         | viewer cookie or `x-viewer-token` | Allowlisted proxy to the bridged OpenCode; `:id` is forced to the token's session. |
| `GET /join`, `GET /terminal` | none                       | Code-entry page and the viewer UI.               |
| `GET /api/health`         | none                          | Static `{healthy:true}` so the viewer UI selects the base-URL-prefixed API dialect. |

## Development

Node.js ≥ 22. Each package builds and tests independently:

```bash
cd relay  && npm install && npm test && npm run build   # vitest + tsc → dist/
cd bridge && npm install && npm test && npm run build
```

Relay env vars (see `relay/.env.example`): 
`PORT` (default 8080), `ACTIVATE_FAIL_DELAY_MS` (brute-force brake, default 1000).

## Deployment

Push to `main` deploys automatically (build → GHCR → SSH). Server bootstrap, TLS,
nginx, and rollback: [DEPLOY.md](DEPLOY.md).

## Documentation

- Design spec (RU): [docs/superpowers/specs/2026-09-05-opencode-remote-control-design.md](docs/superpowers/specs/2026-09-05-opencode-remote-control-design.md)
- Implementation plan: [docs/superpowers/plans/2026-09-05-opencode-remote-control-plan.md](docs/superpowers/plans/2026-09-05-opencode-remote-control-plan.md)
- Deployment runbook: [DEPLOY.md](DEPLOY.md)
