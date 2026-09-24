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
of every token, rate-limits code guessing, and the proxy adapter refuses any viewer request
for a session other than the one that issued the viewer token, or a subagent of it
(allowlisted OpenCode endpoints only).
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
| Answer permission prompts raised by that session or its subagents | `POST /session/:id/permissions/:permissionID` |
| Answer or dismiss questions the agent asks in that session or its subagents | `POST /question/:requestID/reply`, `POST /question/:requestID/reject` |
| Read your OpenCode config as the machine sees it — **including provider API keys and MCP `Authorization` headers**, whenever the config holds them | `GET /config`, `GET /global/config`, `GET /config/providers`, `GET /provider` |

So the access code is a credential to the project directory. Hand it only to someone you
would let sit at your keyboard, and stop the share when they are done.

That last row is worth reading twice: the viewer UI fetches those routes while it boots,
so a viewer who types nothing at all has already been handed whatever credentials your
config carries. It is not a hole the share opens on its own — anyone who can run a
command can read the same files — but "controls the session" does not sound like "reads
your API keys", so: it reads your API keys. Rotate what a share saw if you shared with
someone you would not give those keys to.

### What a viewer does NOT see: your other work in the same folder

A share is one session; OpenCode's event stream is one **directory**. The bridge
subscribes to `/event?directory=<the shared project>` and receives everything that
happens there — sessions you never shared included. Of the ~89 event kinds OpenCode
1.18.32 emits, 31 carry no session id at all, and those are not filtered by the session
binding above, because there is nothing in them to bind. Until this was fixed they were
all forwarded as "global", so a viewer of one share watched your parallel work in the
same folder: the command line, arguments and working directory of every terminal you
opened (`pty.created`), what you were typing into your own TUI (`tui.prompt.append`),
your toasts and the paths in them (`tui.toast.show`), the files the edit tool touched
(`file.edited`), the project record `GET /project` is deliberately filtered to withhold
(`project.updated`), the worktrees `/experimental/worktree` is unrouted to withhold.

An event that names no session is now forwarded only if its kind is one the viewer's UI
needs and whose payload the viewer is already served elsewhere:

| Forwarded with no session id | Payload | Why a viewer still gets it |
| ---------------------------- | ------- | -------------------------- |
| `server.connected` | empty | OpenCode's handshake, re-sent when the bridge re-dials; the UI reloads the session on it |
| `server.heartbeat` | empty | OpenCode's keep-alive |
| `lsp.updated` | empty | the UI refetches `GET /lsp`, which a viewer may already read |
| `reference.updated` | empty | the UI refetches `GET /experimental/resource`, which a viewer may already read |
| `vcs.branch.updated` | the branch name | the branch in the session header; `GET /vcs` answers the same value at boot |
| `file.watcher.updated` | a path under the shared directory, and add/change/unlink | the UI reloads an open file, refreshes the file tree and re-reads the review panel's diff; the viewer already lists and reads that whole tree through `GET /file`, `GET /file/content` and `GET /find` |

Everything else carrying no session id is dropped, and counted by kind under
`events_dropped` in `/health` (operator side) so a kind that turns out to be needed is
one read away rather than a panel that silently never updates. The last row is the one
trade in the list: it tells a viewer *when* something under the shared directory changed,
which is the price of a file view and a review panel that stay live.

Your terminals are out for the same reason on the request side: **no `/pty` route is
proxied**. `GET /pty` answers with every terminal you have open in the shared project —
command, arguments, working directory and pid — which is the same disclosure on a poll
that dropping `pty.created` prevents on a push; and creating, attaching to, resizing or
closing a terminal was never routed either, so the viewer's terminal panel could list
terminals it had no way to open. It now lists none.

Nothing else here is a limit on what a viewer can *ask* for: every route in the "What
sharing grants" table is still theirs. It only stops the session you shared from carrying
the sessions you did not.

| What protects the share | Detail |
| ----------------------- | ------ |
| Access code | 6 characters from a 34-symbol alphabet (`A–Z0–9` minus `O` and `I`) ≈ 30 bits. Small enough that it only holds up because guessing is throttled. |
| How long the code and the viewers last | **A share that comes back does not lock out the people already in it.** Sharing the same conversation again from the same install — after OpenCode was killed, after a reboot, or just by running `/remote-control/start` again — keeps the access code and every viewer token that share already had: the start proves the install with its owner key *and* presents the code it recorded for that share (`~/.agents/skills/remote-control/state/<session>.json`, 0600), and the relay, which holds only a salted hash, continues the share it recognises instead of replacing it. Codes used to be minted fresh on every registration, which sent every open tab back to a code-entry page holding a code that no longer existed — with no way to tell anyone the new one, since viewers are usually somewhere else entirely and the new code exists only in `bridge.log` on the machine that just crashed. What this lengthens: a code you have handed out lives until you stop the share, not until your next crash. What still revokes it, together with every viewer token, at once: `/remote-control/stop`, the relay reaping the share (24 h without bridge traffic, or 5 minutes for a registration no bridge ever took up), a full relay ending it to make room, and the relay losing the session for any other reason — after any of those, the next share of that conversation is a new share with a new code, whatever it presents. So is a share started from another install, or after the 30-day reservation lapsed. A wrong-code lockout is *kept* across such a restart, deliberately: it is counted against the code, and the code is still live. |
| Per-session lockout | **Five wrong codes in a row against one share lock activation for it for 15 minutes**, wherever the attempts came from. Counted per session, not per address, because an address costs nothing to change and a grind is simply spread across many; the share is the one thing an attacker cannot swap. Counted *consecutively*, so anyone getting in clears the run — a colleague's typo is forgotten the moment somebody joins. That caps guessing at 480 attempts a day against ~1.5 billion codes: on the order of 4,400 years to an even chance. While locked, activation is refused for everyone including a correct code — admitting it would let a distributed attacker keep guessing at full speed and win on a lucky try, which is exactly what the lock prevents. A specific wrong code is refused outright after 3 repeats. |
| No per-address limit on guesses | Deliberate. It throttled colleagues behind one office NAT — the sixth person with a perfectly good code was told "too many attempts" — while the attacker it was aimed at just changed address. `RELAY_TRUST_PROXY` still matters, because registration caps (12/hour, 5 active shares per address) do key on the client address; see [DEPLOY.md](DEPLOY.md). nginx also rate-limits the endpoint at the edge. |
| Wrong-code delay | Every rejected code is answered after a ~1 s delay (`ACTIVATE_FAIL_DELAY_MS`), so each guess costs real time. |
| Forced session binding | The proxy routes only allowlisted paths, and the `:id` in each of them must be the token's own session or a session the relay has walked up to it (its subagents, readable as themselves on the subagent routes and folded into the share elsewhere — they belong to it, and the parent waits on their permission and question prompts). Any other `:id` is **refused** with `401` marked `X-OC-Relay-Auth: viewer-invalid`, never silently rebound onto the viewer's own session: rebinding carried a tab's prompt or shell command out in whichever session the cookie named last, on someone else's machine, with the answer coming back as if nothing had happened. The marked 401 sends that tab back to its own share's code-entry page instead. An `:id` whose walk the relay could not finish — the bridge is away, or OpenCode answered an error — is `502 {"error":"bridge not connected"}`, not `401`, so a blip never costs a viewer its token. Each page the relay serves *for a share* also names it on every same-origin request (`X-OC-Relay-Share`), and a request naming a share other than the token's is refused the same way — that is what protects the routes carrying no `:id` of their own (`/permission`, `/config`, `/event`) from a tab whose cookie a join in another tab replaced. A request that names no share (the share-less `/terminal` page, a non-browser client, an older shell) is treated exactly as before: the header can only refuse, never widen. The bridge re-checks each forwarded path against its own allowlist before touching OpenCode. |
| Viewer tokens | HttpOnly, `SameSite=Strict`, `Secure` cookie; salted-hashed at the relay; expire after 24 h of inactivity (sliding) **and after 7 days whatever the use** — the sliding window alone never ran out for a tab left open, since its event stream slid it on every heartbeat. Capped at 32 per session. At the cap only an *idle* seat is reclaimed — a viewer seen in the last 5 minutes is never displaced, and a genuinely full share tells the next person so instead of quietly taking someone's place. A viewer can also end their own access at any time with `POST /api/leave`, which drops that one token, closes its event stream and takes the cookie back. It is an endpoint, not a button: no page the relay serves calls it, so after joining from a machine that is not yours, ending that access means calling it (or clearing the relay's cookie in that browser) — otherwise the token lives on until it lapses or the owner ends the share. One cookie per origin also means one share per browser profile: joining a second share replaces the first share's token, and the first tab is sent back to its own code-entry page on its next request rather than acting in the share that joined last. Two shares at once means two browser profiles (or a private window). |
| Viewer mint rate | A session accepts at most 64 successful activations per 10 minutes, whoever presents the code. It bounds how fast tokens can be minted; it is deliberately far above a real team, because a room of colleagues joining and one machine churning tokens look identical by volume — the seat rule above is what protects the people already in. |
| Ownership of the link | The link names OpenCode's session id, which is reused whenever that conversation is shared again. Each registration carries an owner key (an HMAC of the relay's origin and the id under a secret created once per install, `~/.agents/skills/remote-control/state/owner.key`; bound to the relay, so a self-hosted or mistyped relay that reads it learns nothing it could use on another), so after a share ends its id stays reserved for that install for 30 days: someone holding an old link cannot register it first and serve their own join page under it. The reservations live in one bounded map (100,000 entries), and it is not an unconditional promise once that map is full: a new reservation is then recorded only if it can take room from an address block holding at least two reservations and no more than the registrant's own block holds, and otherwise it is simply not recorded — that id is left unreserved, as it was before reservations existed. That is deliberate and fail-closed: a reservation already held is never handed to somebody else, whatever the volume of registrations. It is not silent either: the relay logs the state (at most one line an hour, since what fills the map is a flood) and counts the refusals in `claims.refused` on the operator's side of `/health`, so "ids are no longer being reserved" is something to alert on rather than something an owner discovers from a stranger's join page. The same key also lets a restart take back a share whose bridge died — with its access code and its viewers, when the restart can still show the code that share was minted with (see the row above). |
| Which server the share runs on | The bridge only attaches to a local server that **holds the session being shared** (`GET /session/<id>`, or a session in the shared project when the start still has to pick one); anything else is passed over and it starts an `opencode serve` of its own. Health alone decided this before, and `/global/health` is one route any process running as you can answer, so the first such listener — a leftover stub, a dev server, something put there on purpose — became the upstream of the share, saw every proxied request and decided every answer the viewer got. It was also handed the `Authorization` header, i.e. your `OPENCODE_SERVER_PASSWORD`. Candidates are now asked without credentials first, so only a server that demands them is sent any. It is a check against accidents and against anything that cannot produce your session; a process running as you that mimics opencode in full is not something a loopback probe can tell apart, and it could read that session from disk anyway. `OPENCODE_REMOTE_CONTROL_PORT` skips the whole test for a server you name yourself. |
| Transport and storage | TLS terminates at nginx; the persisted session set is encrypted at rest (AES-256-GCM) with a key kept off the state volume. |

What it does **not** protect against:

- **Someone you gave the code to.** There is no per-viewer identity, no read-only mode and
  no per-person audit trail. Sharing is trusting; the only revocation is ending the share.
- **An unsecured OpenCode server on your own machine.** A share needs OpenCode's HTTP
  server on `127.0.0.1`, and that server has no password unless `OPENCODE_SERVER_PASSWORD`
  is set: it accepts any local caller, reflects CORS for any loopback origin and checks no
  `Host` header, so any page in your browser — a local dev server, a dependency that
  started one, a site that resolves its own name to 127.0.0.1 — can create a session, read
  your projects and run a command as you. The relay and the access code are not involved
  in that at all. The bridge sets a random password on the server it starts itself, so the
  gap is a server **you** started (`opencode serve`, the desktop GUI, `opencode acp`) and
  attached to: set `OPENCODE_SERVER_PASSWORD` before starting it. What a share will *not*
  do any more is run on some *other* local listener: it attaches only to a server that has
  the session being shared (see the table above), and asks a candidate for credentials only
  once that candidate has demanded them.
- **A compromised relay host.** It keeps no plaintext secrets, but it mints the access code
  and routes every proxied request, so it sees a live share's traffic — prompts, command
  output, any file a viewer opens — and can issue requests of its own. The bridge's own path
  allowlist is the defense-in-depth here: anything outside it is refused with a 403, and the
  `:id` in an allowlisted path must be the shared session — another `ses_…` is accepted only
  for a session the bridge has itself walked up to that one (its subagents), and the
  directory is pinned to the shared project. So a hostile relay is confined to the
  conversation you shared. It is not confined to *less* than that: those paths run commands
  in it, so a relay you do not trust is a machine you do not control. Trust the relay URL —
  and its TLS — the way you trust the person you gave the code to.

Ending a share: `/remote-control/stop` (deletes the relay session, revokes the code and
every viewer token, and disconnects the bridge), quitting OpenCode (the watchdog does the
same), or leaving it alone — the relay reaps a session after 24 h without bridge traffic,
or 5 minutes after registration when no bridge ever connected to it. A relay that is full
(it holds `RELAY_MAX_SESSIONS` shares, 2,000 by default) does not wait out that day: a new
share takes the slot of the one whose bridge has been gone longest, once that bridge has
been gone for more than 5 minutes — a laptop closed over lunch, say. A share whose bridge
is connected is never ended this way. When that bridge comes back the relay refuses it
with 401 and it stops (`Remote control stopped: …`); run `/remote-control/start` again —
the link stays the same, since the id stays reserved for your install, and the code is
new, because the share itself is gone from the relay and there is nothing left for the
code to belong to. Every share ended to make room is logged, so the operator can raise the
cap (see [DEPLOY.md](DEPLOY.md#session-cap-relay_max_sessions)).

A share the relay still holds is different, and it is the common case: OpenCode was
killed, the machine rebooted, or you simply ran `/remote-control/start` again. That start
takes the share back rather than replacing it — same link, **same code**, and everyone
already watching stays watching, their tab never even sent back to the code page. It
needs both the install's `owner.key` and the code recorded in that share's state file, so
a start from another machine, or one whose state file is gone, gets a new code and clears
the old viewers with it.

That reservation opens only to the install that made it (its `owner.key`). Starting the
same conversation from another install — another machine or `HOME`, or this one after
`owner.key` was deleted — is refused for 30 days after the share ended with
`session … is reserved on the relay (409) for the install that shared it last`; there is
no share to stop, so share it from that install again, or share another session. A plugin
from before owner keys sends no key and is refused the same way, but says only
`relay createSession failed: 409`: after rolling the plugin back past owner keys, share a
conversation the current version shared from the current version, or share another session.

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
| Terminal UI (`opencode`) | TUI | `tui.json` (also `$OPENCODE_CONFIG_DIR/tui.json`, `tui.json` and `.opencode/tui.json` in the project and its parents, `$OPENCODE_TUI_CONFIG`) | `./tui` → `plugin/remote-control.js` |
| Desktop GUI, web UI, `opencode run`, `opencode serve`, `opencode --mini`, ACP clients (`opencode acp`) | server | `opencode.json` (also `<project>/.opencode/opencode.json`, auto-discovered `.opencode/{plugin,plugins}/*.js`) | `./server` → `plugin/server.js` |

> Registering in only one file leaves the commands missing on the other side —
> the GUI has no TUI at all, so a TUI plugin can never reach it. A single module
> may export **either** `tui()` **or** `server()`, never both (the loader rejects
> a module with both), so the package ships two entry points over one shared
> implementation (`plugin/bridge-runner.js`). The package's default export
> (`.`) is the **server** entry: an OpenCode hosted by Node rather than Bun —
> the desktop app's sidecar — resolves the plugin by its bare name, and the
> server entry is the one a host without a TUI can use.

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
Both act on the session they are typed in, or on the shared session a subagent
session belongs to, so a share running on this machine for another session is
never ended by mistake. Typed anywhere else (a new session, a new desktop tab,
or `opencode run`, which starts a new session every time) they end nothing and
name the sessions shared from this machine instead; type the command in that
session, or from a terminal run
`opencode run --session <id> --command remote-control/stop` (or
`opencode run --session <id> --command remote-control/status`). The result —
the share ended, nothing to stop in that session, or why the stop failed — is
printed on stderr; the `OK` after it is only the model acknowledging the turn
and looks the same whatever happened. The exit status tells them apart: a stop
exits 0 only when it ended a share, and 1 when there was nothing to stop in that
session or the stop failed, so a script's `&&` goes on only after a share really
ended. A status exits 0 whatever it found, and 1 only when it failed. That is
`opencode run` on its own: `opencode run --attach <server-url>` hands the command
to that server, prints only the model's `OK` and exits 0 whatever the stop did, so
there its `&&` proves nothing — the result is in the session, which
`opencode attach <server-url> --session <id>` shows.

The bridge also stops on its own when OpenCode quits (watchdog) or on SIGINT/SIGTERM;
every stop path deletes the relay session, revokes the code, terminates the bridge
process recorded in its state file and the `opencode serve` it may have spawned.
The watchdog follows the OpenCode process the share was started from (the plugin
passes its pid as `--owner-pid`), not just the server the bridge talks to. A plain
`opencode run` exits right after its command, so a share it started would be gone
within seconds; `opencode run --command remote-control/start` therefore starts
nothing, says so on stderr and exits with status 1 (so a script's `&&` stops
there), instead of printing a code that stops working at once. Start a
share from a long-running client (the TUI, the desktop app, `opencode web`); from a
terminal, keep `opencode serve` running, open it with `opencode attach <server-url>`
(add `--session <id>` for an existing session) and type `/remote-control/start`
there: the command runs in that server, so the share lives as long as the server
does, and the URL and code appear in the session on screen. `opencode run --attach`
against that server starts a share as well, but prints only the model's `OK`, never
the URL and code; they are in the session, where `opencode attach` shows them. The
bridge's `start` can also be run by hand, without `--owner-pid`.

### Surviving a bad network

A dropped connection usually does not close: it goes half-open, and both ends keep
believing the link is up while nothing crosses it. Every hop therefore has to prove
it is alive:

| Hop | Keep-alive | Env override |
| --- | ---------- | ------------ |
| bridge → relay (WS) | Pings every 20 s. The link counts as dead only after two intervals with no progress at all — no pong, nothing from the relay, and no movement of a backed-up send queue — because on a saturated uplink the ping itself waits behind megabytes of data and a working link would otherwise be cut. The bridge then re-dials with exponential backoff (1 s → 30 s, ±20% jitter) until it is back. A dial that gets no answer for 15 s (TCP, TLS or the upgrade) is abandoned and retried the same way, so a re-dial into a still-dead network cannot hang forever. A deliberate close from the relay (session stopped, credentials revoked) shuts the bridge down instead of retrying. | `REMOTE_CONTROL_WS_PING_INTERVAL_MS`, `REMOTE_CONTROL_WS_HANDSHAKE_TIMEOUT_MS`, `REMOTE_CONTROL_RECONNECT_BASE_MS`, `REMOTE_CONTROL_RECONNECT_MAX_MS` |
| relay → bridge (WS) | Pings every 25 s; a bridge that shows no sign of life for two rounds — no pong and not a single byte — is terminated, so its session slot is freed for the reconnect. A GET caught by a drop waits up to 5 s for the bridge to come back and is answered then (a POST is never repeated); a bridge that is simply gone fails fast, and so does a GET whose share is stopped meanwhile — it is never sent to a new registration of the same id. A prompt waits up to 120 s for its answer, and one whose answer is lost to a drop or that timeout is checked instead of reported failed: if OpenCode has its message, the viewer gets the 204 OpenCode gave, so the UI does not take the prompt back and invite a second, duplicate turn. A pong or incoming data also refreshes `last_seen`, so an idle but healthy share is never reaped. | `RELAY_WS_PING_INTERVAL_MS`, `RELAY_WS_PONG_GRACE_ROUNDS`, `RELAY_BRIDGE_RECONNECT_WAIT_MS`, `RELAY_PROMPT_TIMEOUT_MS` |
| relay → viewer (SSE) | A `server.heartbeat` event every 15 s, independent of bridge traffic, so intermediate proxies keep the stream open and the browser can tell a quiet session from a dead one. A viewer that stops reading is dropped once 2 MiB of events wait for it on top of one large event still queued, and reconnects; nobody's stuck phone can make the relay buffer without bound, while one event bigger than that (a pasted image, a large diff) still reaches a viewer that keeps reading. Only 32 MiB of that one event is let off, though, and never more than the largest single frame a bridge may send (`RELAY_BRIDGE_MAX_PAYLOAD_BYTES`), which this is clamped to rather than exceeding: a viewer still behind on more of it than that when the next event or heartbeat is due is dropped as well, so even one huge event cannot sit unread in the relay. All streams together hold at most 128 MiB over that at once: an event that would go past it is not queued, and that viewer is dropped and reconnects rather than the relay running out of memory when one huge event reaches many stuck streams. Events OpenCode emits while the bridge link is down never reach the relay, so when the bridge re-dials every open viewer stream gets `server.connected` again (the UI reloads status, permissions and questions) and the latest 20 messages replayed as message events, paced to the viewer; a message or part deleted during the outage still needs a reload. Reply text (or reasoning) still being written is not replayed, since OpenCode stores it only once it is complete: the viewer keeps what it already shows, the text streamed during the outage is missing until that text is complete, and text begun during the outage appears then, in full. | `RELAY_SSE_HEARTBEAT_MS`, `RELAY_SSE_MAX_BUFFER_BYTES`, `RELAY_SSE_MAX_EXEMPT_BYTES`, `RELAY_SSE_MAX_PARKED_BYTES` |
| bridge → OpenCode (SSE) | Re-subscribes to `/event` when the local stream ends (server restart), so a reconnected share is never silently event-less. While the relay socket has more than 1 MiB queued it stops reading events until the queue drains, so a slow uplink delays events instead of burying viewer requests behind them. | `REMOTE_CONTROL_EVENT_RETRY_MS`, `REMOTE_CONTROL_EVENT_HIGH_WATER_BYTES` |
| bridge → OpenCode (health) | The watchdog probes the local server every 10 s and gives each probe 5 s. The share ends only after 3 failed probes in a row, so a server that is busy for a moment keeps its share (and, on the TUI path, is not killed); one that is really gone is still caught. Each failed probe is logged with its cause, and the bridge's last line says why the share ended (`Remote control stopped: …`). | `REMOTE_CONTROL_WATCHDOG_INTERVAL_MS`, `REMOTE_CONTROL_WATCHDOG_TIMEOUT_MS`, `REMOTE_CONTROL_WATCHDOG_STRIKES` |
| bridge → relay (traffic) | Response bodies of 8 KiB and more are gzipped once the relay announces support in its first frame (transcripts shrink 3-10x on the owner's uplink). The relay inflates at most 32x the compressed size, so a hostile "bridge" cannot send a decompression bomb; a body that compresses better than that is simply sent uncompressed. That first frame also names the relay's own frame cap, so a bridge never sends a frame it already knows the relay will refuse: a response past it is answered `413` and an event past it is dropped, rather than costing the owner the link and every request on it. A relay too old to name it is taken at the 100 MiB every shipped bridge was built against. | — |
| relay restart | The session set is persisted, encrypted at rest (AES-256-GCM) with a key kept off the state volume, so redeploying the relay no longer ends live shares: the bridge reconnects, viewers' cookies still work, and unused join codes keep working too. A stolen copy of the volume is useless without the key. This holds only while `RELAY_STATE_KEY` stays the same: a relay that cannot decrypt its file starts empty and logs why, each bridge is refused with 401 and exits, and every share has to be started again (the old file is moved aside, not overwritten; see [DEPLOY.md](DEPLOY.md#session-state-volume)). | `RELAY_STATE_FILE`, `RELAY_STATE_KEY` |

A share that really is gone (stopped, or aged out) answers with a page saying
so and how to get a new link, instead of a bare 404.

In the terminal UI the TUI entry (`plugin/remote-control.js`) provides
`/remote-control` (a picker) plus `/remote-control/start`, `/remote-control/stop`
and `/remote-control/status`, running the bridge directly — no LLM prompt, instant.
The server entry, which a plain `opencode` loads too, leaves those names to it
when it finds the TUI entry in a file the terminal UI reads: `tui.json` or
`tui.jsonc` in `$XDG_CONFIG_HOME/opencode` (`~/.config/opencode`),
`$OPENCODE_CONFIG_DIR`, `~/.opencode`, the project directory and each of its
parents (and their `.opencode/`, unless `OPENCODE_DISABLE_PROJECT_CONFIG` is
set), or `$OPENCODE_TUI_CONFIG`. An entry commented out there does not count,
nor does one in a file the terminal UI skips as invalid: a setting of the wrong
type, such as `"scroll_speed": "fast"`, drops the whole file, its plugins
included (`skipping invalid tui config` in opencode's log). An entry written
with `{env:…}` or `{file:…}`, or listed under `"tui"`, counts, as it does for
opencode. An entry switched off with `plugin_enabled` (or in the terminal UI's
plugin list) still does, so that terminal has no `/remote-control` command until
the plugin is switched back on.

`opencode attach <url>` is a terminal UI too, but its server is a separate
process, and one that has the server entry (an `opencode serve` with it in
`opencode.json`, say) lists the same four commands. The `/` menu would show each
of them twice, so the TUI entry leaves the slash names that server has to it.
Typed there, a command runs in the server, as it does in the web UI: its output is
the command's message, the model answers `OK` under it, `/remote-control` without
an action reports status instead of opening the picker, and a share it starts
follows that server's process rather than the terminal. The picker and the
direct, LLM-free actions stay in the command palette (ctrl+p, "Remote control");
those run in the terminal's own process, so a share started from there ends when
that terminal exits.

In the desktop GUI, the web UI and `opencode run` the same four commands come from
the server entry (`plugin/server.js`): it registers them through the `config` hook
and runs the action itself in `command.execute.before`, so the share is started by
the plugin. Its output — the URL and code, or what stop and status found — is the
command's message, and the model only acknowledges it with `OK`. `opencode run`
prints a turn's reply but never that message, so there the plugin also writes the
output to stderr (stdout stays the reply, or the events of `--format json`).
`opencode run` reaches that hook only through `--command`
(`opencode run --command remote-control/status`): a message such as
`/remote-control/stop` is sent to the model as an ordinary prompt, runs
nothing, and lands in the session where a viewer can read it.

`opencode --mini` loads no `tui.json` plugin, so it gets the server entry's
commands as well. Mini draws the model's reply but not the command's message, so
there the model is asked to repeat the output verbatim instead of answering `OK`
(its first reply text is held back for a moment, or mini would draw it only after
your next prompt). What mini shows is therefore the model's copy of the output;
the message with the plugin's own text stays in the session. That holds only for
a mini that runs its own server. With `opencode attach <url> --mini` the command
runs in the attached server, which cannot tell a mini client from the others, so
the reply stays `OK` and the output is not drawn: resize the terminal (mini then
redraws the session, output included), or attach without `--mini`.

ACP clients (Zed and other editors that run `opencode acp`) get the server
entry's commands too, and never see the command's message either: while a prompt
runs, `opencode acp` streams the model's reply to the editor but not the user
message, and its stdout and stderr belong to the protocol and the editor's log.
So there, too, the model is asked to repeat the output verbatim, and what the
editor shows is the model's copy of the URL and code. Reopening the thread
replays the session, the plugin's own message included, so the output then
appears twice, and an editor that ignores the "for the assistant" marking on the
plugin's instruction to the model shows that instruction as well. `opencode acp`
also listens on HTTP (127.0.0.1:4096 when that port is free, or `--port`), and a
command sent through that server by another client (`opencode attach`, the web
UI) runs in the same process, which cannot tell that client from the editor: its
reply is the model's copy too, so such a client shows the URL and code twice, in
the plugin's message and in the reply below it.

The TUI itself exposes no HTTP port, so the bridge starts its own
`opencode serve` against the same project and stops it again on
`/remote-control/stop`. That server is password-protected (the bridge generates
`OPENCODE_SERVER_PASSWORD` for it and keeps it in memory); a server **you** started and
the bridge merely attached to is only as protected as you made it — see the security
section above, since anything in your browser can otherwise drive it.

#### How the bridge finds that server

It lists the TCP ports `node`/`opencode` processes listen on (`lsof`) and asks
each, in turn, two questions: does it answer `/global/health`, and **does it
hold the session being shared** — `GET /session/<id>` for a share that names its
session, `GET /session?directory=<project>` for one that still has to pick a
session from it. The first port that answers both serves the share; a port that
answers only the first is passed over with a line saying so. When nothing
qualifies, the bridge starts an `opencode serve` of its own, exactly as it does
on the TUI path.

The health question alone used to be the whole test, and it is one route any
process running as you can answer — so a leftover stub, a dev server, or
something put there on purpose became the upstream of the share whenever it
started before your opencode. Measured in production: two stub servers took two
shares in a row, each of which registered, reported `bridge: connected`, and
answered every viewer `401`. The session question is the one a stranger cannot
answer. Credentials follow the same rule: a candidate is asked without any
first, so a server that answers anybody is never handed your
`OPENCODE_SERVER_PASSWORD`.

Detection can be skipped altogether with `OPENCODE_REMOTE_CONTROL_PORT` (or
`--port` when running the bridge by hand): the named server is used as it
stands, unasked, because naming it is you saying which server is yours.

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
| `nginx/`  | Host nginx vhost and rate-limit zones (TLS termination → `127.0.0.1:8080`, authoritative `X-Forwarded-For`, the edge limits and the `/bridge` guard). **Installed and updated by hand** — no deploy step ships it; see [DEPLOY.md](DEPLOY.md). |
| `.github/workflows/deploy.yml` | Push to `main`: run the test suites → ship `relay/` over SSH → build and restart on the host → health check (or automatic rollback). See DEPLOY.md. |

## Relay HTTP surface

| Endpoint                  | Auth                          | Purpose                                          |
| ------------------------- | ----------------------------- | ------------------------------------------------ |
| `GET /health`             | none                          | Liveness: `{ ok, healthy, sessions, version }`, plus `faults`, `claims` and `events_dropped` for a caller on the relay's own side. `faults` is `{ swallowed, last_at }` — errors that escaped a call stack and were survived rather than fatal; it never moves `ok`/`healthy`, because restarting over a survivable error would end every live share. `claims` is `{ held, refused }` — how many ended shares' ids are reserved for the installs that shared them, and how many reservations a full map has had to turn away since start (a `refused` that moves means ids are no longer being kept). `events_dropped` is `{ <event kind>: <count> }` — opencode events the viewer's stream withheld because they carry no session id and the kind is not one a viewer needs (terminals, TUI typing, the project record; see "What a viewer does NOT see"). It is the answer to "that panel never updates": a kind counted there is a kind no viewer is being shown. All three are left out for anything arriving through the edge (nginx marks those by appending to `X-Forwarded-For`): a counter that moves when a handler throws tells an anonymous caller whether their own request found a bug, the second tells a flood how far along it is, and the third describes what the owner's opencode is doing — the very thing the event filter exists to withhold. Probed by the Docker HEALTHCHECK, compose, and `bridge status` (all read the status only); the counters are read on the host, `curl http://127.0.0.1:8080/health`, or by a monitor running there. |
| `POST /api/sessions`      | public (rate-limited)      | Create a session; returns the access code + bridge token exactly once. An id already taken gets `409`: `{"error":"session exists"}` while a share holds it, `{"error":"session reserved"}` while an ended share reserves it for another owner key. An optional `access_code` alongside a matching `owner_key` CONTINUES the share the relay already holds for that id instead of replacing it — the same code comes back and its viewer tokens stay valid; the relay keeps only a salted hash of the code, so this recognises a code and never sets one, and anything it does not recognise (including a code for a session it no longer holds) is an ordinary new share with a new code. Malformed, it is a `400` rather than ignored: silently minting a new code would take the share's viewers with it. |
| `GET /api/sessions/:id`   | public                        | Session presence check (bridge `status`).        |
| `DELETE /api/sessions/:id`| `x-bridge-token` (owner only)    | End a session; disconnects its bridge, revokes code + tokens. |
| `POST /api/activate`      | access code (rate-limited)    | Exchange a code for a viewer token, sent only as an HttpOnly, SameSite=Strict cookie; the body is `{ session_id }`. |
| `POST /api/leave`         | viewer cookie or `x-viewer-token` | Hand that one viewer token back: it is dropped at the relay, its event stream ends, and the cookie is cleared. The response also sends `Clear-Site-Data: "cache", "storage"`, which clears this origin's storage — including the drafts and prompt history of any other share opened in the same browser — and this host's cache. Not `"cookies"`: that directive is defined over the whole registrable domain, so it would log the viewer out of every neighbouring subdomain, and the relay's own cookie is already taken back by the `Set-Cookie` on this response. No body, and `204` whether the token was live or not — a logout must not double as a check on whether a token is live. A cross-origin POST is refused with `403 {"error":"cross-origin request forbidden"}` before the token is even read; a request with no `Origin` header at all (curl, a CLI) is accepted. No page the relay serves calls it: it is an endpoint for integrations and for a viewer's own tooling, not a button in the UI. |
| allowlisted OpenCode paths at the root (`/session/:id/…`, `/provider`, …) | viewer cookie or `x-viewer-token` | Proxy to the bridged OpenCode; the `:id` must be the token's session or a proven descendant of it — anything else is `401` with `X-OC-Relay-Auth: viewer-invalid` (or `502` if the descendant check could not be finished), never a rewrite onto the token's own session. |
| `GET /event`, `GET /global/event` | viewer cookie or `x-viewer-token` | Live SSE fan-out of the session's OpenCode events, filtered to the viewer's session. Each stream reproduces OpenCode's own envelope: `/event` sends the bare event, `/global/event` wraps it as `{ directory, payload }` — the web UI reads `payload` and breaks on anything else. |
| `GET /join`, `GET /terminal` | none                       | Code-entry page and the viewer UI.               |
| `GET /global/health`, `GET /api/health` | none            | Static `{healthy:true}`, answered by the relay itself (never proxied), so the viewer UI's protocol probe selects the base-URL-prefixed API dialect without waiting on the bridge. |

Request sizes are capped per side, because the two sides want opposite things: the
unauthenticated JSON API (`POST /api/sessions`, `POST /api/activate`) accepts at most
**32 KB**, while authenticated proxy traffic gets **25 MB** so a viewer can paste a whole
file into a prompt. The proxy's parser is mounted behind the viewer check, so an anonymous
request can never make the relay buffer the larger limit. Anything over the cap gets
`413 {"error":"payload too large"}`; a body that is not JSON gets
`400 {"error":"invalid json"}`, and one in a charset or content encoding the relay cannot
decode gets `415 {"error":"unsupported media type"}`. None of these is logged.

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
| `RELAY_WS_PING_INTERVAL_MS`, `RELAY_WS_PONG_GRACE_ROUNDS`, `RELAY_SSE_HEARTBEAT_MS`, `RELAY_SSE_MAX_BUFFER_BYTES`, `RELAY_SSE_MAX_EXEMPT_BYTES`, `RELAY_SSE_MAX_PARKED_BYTES`, `RELAY_BRIDGE_RECONNECT_WAIT_MS`, `RELAY_PROMPT_TIMEOUT_MS` | relay | Keep-alive tuning — see the table above. |
| `RELAY_SSE_RETRY_MS` | relay | Reconnect delay a viewer's event stream advertises (SSE `retry:`, default 3000). The web UI takes it as the base of its backoff and doubles it on every failed attempt, up to 30 s. |
| `RELAY_MAX_SESSIONS` | relay | Most shares the relay holds at once, whoever registered them (default 2000). A full relay makes room by dropping registrations no bridge took up and then the share whose bridge has been gone longest (more than 5 minutes); only when neither frees a slot does it answer 503 `relay full`. Ending a share and refusing one are both logged. See "Ending a share" above and [DEPLOY.md](DEPLOY.md#session-cap-relay_max_sessions). |
| `RELAY_BRIDGE_MAX_PAYLOAD_BYTES`, `RELAY_PROXY_MAX_BUFFERED_BYTES` | relay | DoS bounds on response buffering. The first caps the largest single frame a bridge may send (default 100 MiB, also the limit a compressed body may inflate to); a larger frame is rejected before it is buffered, which costs the bridge its link rather than the request, so the default is the ceiling every shipped bridge was built against and lowering it is only safe for an install whose bridges are new enough to be told: the relay announces the value in its first frame and a bridge that understands it answers `413` instead of sending the frame, while an older one still sends up to 100 MiB and loses its link over it — a live event carrying a pasted image is one uncompressed frame, and a transcript larger than the cap is answered 502 however small it was on the wire. It is the ceiling the other byte limits are measured against: the SSE one-frame exemption is clamped to it, what all viewer streams may hold over the per-viewer cap (`RELAY_SSE_MAX_PARKED_BYTES`) is never smaller than one such frame beyond that cap, or an event the relay accepted would drop every viewer it is sent to, and the total below is never smaller than eight of it. The second caps the total response-body bytes the proxy path holds for slow or non-reading viewers at once (128 MiB, or eight frame caps if that is larger — 800 MiB by default, since a body the bridge socket accepted has to be servable; lower the frame cap to tighten it): over it, a new request is answered 503 `relay busy` rather than buffered, so concurrent slow readers cannot exhaust relay memory. One share may hold at most an eighth of that total (and never less than one frame), so a registrant flooding the proxy path with non-reading sockets denies service to itself rather than to every other share. |
| `RELAY_PROXY_BODY_LIMIT_BYTES`, `RELAY_PROXY_MAX_INBOUND_BYTES`, `RELAY_PROXY_MAX_INFLIGHT_POSTS` | relay | DoS bounds on the REQUEST half of the proxy path, the inbound twins of the response bounds above. The first caps one proxied body (25 MiB, the size a pasted screenshot reaches as a data URL); a larger one is answered `413`. The second caps the request bytes the whole process holds for in-flight proxied POSTs at once (128 MiB, or sixteen body limits if that is larger — 400 MiB by default), because a body is buffered whole and held until the bridge answers — twenty concurrent 15 MiB prompts from one registration used to be admitted together; over the ceiling a request is answered 503 `relay busy` before a byte of it is read. One share may hold an eighth of that ceiling and never less than two whole body limits (50 MiB by default), so a viewer can paste twice and a second viewer of the same share can paste at the same time; eight shares at their slice are the whole ceiling, which registration being public would make a cheap outage for everyone else, so an eighth of the ceiling (at most 16 MiB) is reserved for shares whose entire in-flight footprint is under 256 KiB — a prompt, an abort, an answer to a permission or a question, a shell command. About 64 such quiet shares can act through that reserve at once, however full the relay is. What a request is charged is its declared `Content-Length` until the parser has the body, and what the body actually was after that. The declared length is only believed when it describes the body the relay will hold: a request that arrives under a `Content-Encoding` declares its size on the WIRE, and what the parser inflates it into is many times that, so it is admitted conservatively — at one whole body limit (25 MiB), the same as a chunked upload, which declares no length at all. Either one that turns out to be a kilobyte gives the difference back the moment the parser has the body, so the conservative figure is what the relay holds against a request only while it cannot yet know better. A body that arrives slower than the rate floor described below — no byte at all being the extreme of it — is answered `408` and cut, so declaring a maximal body and never sending it holds nothing. What this ceiling bounds is the relay's own heap: behind the shipped nginx (`proxy_request_buffering` is `on` by default and this project leaves it there) the edge reads the body whole and spools it to disk before the relay is asked about it at all, so what the HOST spends on bodies in that deployment is nginx's `client_max_body_size` x `limit_conn` — kept at the relay's own body limit for exactly that reason, see [DEPLOY.md](DEPLOY.md). The third caps how many proxied POSTs one share may have in flight (32), which bounds the small bodies the byte budgets barely notice: each costs a parsed object, a pending bridge request and a timer. Lower the body limit to tighten the aggregate with it — that is the only order in which the two stay coherent, since the ceiling is never below sixteen body limits and `RELAY_PROXY_MAX_INBOUND_BYTES` alone cannot go under that floor. |
| `RELAY_PROXY_STALL_CHECK_MS`, `RELAY_PROXY_STALL_STRIKES` | relay | How long a buffered proxied response may move no bytes at all before the relay cuts it and gives its share the budget back. Checked every 2.5 s, tolerated for four such checks — about ten seconds of complete silence. The tolerance is deliberate: a viewer reading over a slow uplink makes progress at every check and is never cut, but a phone or tablet goes quiet for seconds together on a cell handover, in a tunnel, or with the screen off, and a narrower window turned each of those into a failed request. The wait costs nobody anything while the share still has budget to spare; once the share has actually been refused a body for want of budget, its stalled responses are cut at the first silent check instead, because from then on they are denying that share's own viewers. The same two knobs time a proxied request BODY, but there the test is a RATE, not silence: a window that moves less than ~4.3 KiB/s leaves the body in arrears by the difference, and a debt of four windows' worth is answered `408` and cut, so its bytes come back to the inbound budget. Later bytes pay the debt off, so a burst buys the silence around it, but it does not buy a fresh start — one paid window wiping out the three before it enforced a quarter of the floor and nobody's idea of it. That floor is not a knob of its own: it is as much a minute as the relay calls a SMALL body (an eighth of `RELAY_PROXY_BODY_LIMIT_BYTES`, at most 256 KiB), so lowering the body limit lowers it too, and every real client is orders over it — the 0.74 Mbit/s uplink this relay is sized for is twenty times it. A body that keeps paying it is bounded by the relay's OWN request clock rather than the 300 s `http.createServer()` inherits: `server.requestTimeout` is twice what a maximal body needs on that uplink, rounded to the minute — ten minutes at the shipped defaults, following `RELAY_PROXY_BODY_LIMIT_BYTES` like everything else here. It bounds ARRIVAL only: a request waiting on its bridge, or an event stream open for hours, is long past it. Both of these bite on a body the relay reads itself, which behind the shipped nginx it never does: the edge hands over a complete body on loopback, so there the rate floor and the request clock protect nothing that nginx's `client_body_timeout` has not already cut, and they are what an install exposing the relay directly relies on. |
| `RELAY_SHELL_CSP` | relay | Sends a Content-Security-Policy with the relay's own HTML shells (the join page, the session page, the ended page), naming the sha256 of each script the relay injects into them. **Off by default**, because the page it guards also loads the upstream OpenCode web UI, whose own needs are not ours to guarantee: turn it on only after checking in a browser that the UI still boots, renders a session and streams events with it set. Proxied responses carry `default-src 'none'; sandbox` regardless of this flag — that part is not optional. |
| `RELAY_STATE_FILE`, `RELAY_STATE_KEY` | relay | Where the session set is persisted, and the key it is encrypted with. Empty path = in-memory only. |
| `RELAY_TRUST_PROXY` | relay | Which proxy hop's `X-Forwarded-For` to believe. The registration caps key on it (activation is not limited per address), so a wrong value makes them global — see [DEPLOY.md](DEPLOY.md). |
| `OPENCODE_REMOTE_CONTROL_PORT` | bridge | The local opencode port a share runs on, instead of detecting one. The named server is used as it stands — not scanned for, and not asked whether it holds the session, because naming it says it is yours — so this is also the way past a detection that passes over a server it cannot recognise (`bridge: passing over the server on port …`). Set it where OpenCode itself will see it, since the plugin starts `start` with no flags of its own; `--port` does the same for a bridge run by hand and wins over it. A value that is not a port number warns and detection runs as usual, rather than leaving the owner with no share over a stray setting. `status` reports on that port too. |
| `REMOTE_CONTROL_SESSION_PROBE_TIMEOUT_MS` | bridge | How long a candidate server has to say whether it holds the session being shared (5 s). Longer than the 1.5 s health probe on purpose: this question goes to a server that has just answered as alive, and a missed answer costs the share its own `opencode serve` rather than a skipped dead port. |
| `OPENCODE_REMOTE_CONTROL_RELAY`, `REMOTE_CONTROL_RELAY` | plugin, bridge | Point the slash commands at a self-hosted relay instead of the public one (`https://opencode.b4tr.net`); the first set wins. The value reaches a spawned command line, so it must parse as `http://` or `https://` — anything else warns and falls back to the default; trailing slashes are stripped. A share started before the setting changed stays on its own relay: `stop`, `status` and a later `start` of that session reach it there, and never send its credentials to the relay the setting names now. |
| `REMOTE_CONTROL_WS_PING_INTERVAL_MS`, `REMOTE_CONTROL_WS_HANDSHAKE_TIMEOUT_MS`, `REMOTE_CONTROL_RECONNECT_BASE_MS`, `REMOTE_CONTROL_RECONNECT_MAX_MS`, `REMOTE_CONTROL_EVENT_RETRY_MS`, `REMOTE_CONTROL_EVENT_HIGH_WATER_BYTES` | bridge | Keep-alive tuning — see the table above. |
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
