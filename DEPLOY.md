# Deployment: opencode-remote-control relay

All server-specific values (host, SSH user, paths) are intentionally NOT stored
in this repository. Configure them as secrets/variables in your environment.

## GitHub Secrets (required)

Set these in the repo's Settings → Secrets and variables → Actions:

- `SSH_HOST` — your relay server hostname or IP
- `SSH_USER` — your SSH user on that server
- `SSH_PRIVATE_KEY` — the private key for that user (deploy key)
- `SSH_KNOWN_HOSTS` — the relay host's public host key, one `ssh-keyscan` line

The deploy connects with `StrictHostKeyChecking yes` against `SSH_KNOWN_HOSTS`
and **fails closed** if that secret is empty: without a pinned host key the
first connection trusts whatever answers, and whatever answers receives
`SSH_PRIVATE_KEY`. Produce the line on a machine that already trusts the host
(or read it on the host itself with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`
to compare) and paste it in verbatim:

```bash
ssh-keyscan -t ed25519 "$SSH_HOST"
```

Scan it by whichever spelling you have — the name or the address. The deploy
re-keys the line to the alias every `ssh`/`scp` in the workflow connects by, so
what has to match is the KEY, not the host field of the line you pasted. (That
is not a convenience: the first deploy after this secret was introduced failed
with `No ED25519 host key is known for ... and you have requested strict
checking` because the line had been scanned by hostname while `SSH_HOST` names
the same machine another way.) A secret that holds no key line at all stops the
deploy the same way an empty one does.

The deploy user is in the `docker` group, which on this host is equivalent to
root, so the key is worth protecting further: restrict it in the host's
`~/.ssh/authorized_keys` with `restrict,pty,from="<runner egress>"` if your
runners have stable addresses. A forced `command=` does not fit this pipeline —
the deploy feeds a script over stdin rather than running one fixed command.

## Server bootstrap (one-time)

```bash
ssh "$SSH_USER@$SSH_HOST"
sudo mkdir -p /opt/opencode-remote-control /var/www/certbot
sudo chown "$SSH_USER:$SSH_USER" /opt/opencode-remote-control
```

## Certbot (one-time)

```bash
sudo certbot certonly --webroot -w /var/www/certbot -d opencode.b4tr.net
```

Certbot auto-renew is handled by the host certbot package (systemd timer on Ubuntu 24.04).

## Relay setup (one-time)

`/opt/opencode-remote-control` holds only `docker-compose.yml` and `.env` — the
build context is shipped by the deploy workflow into `~/rc-build/<sha>/`, so no
checkout lives there.

```bash
cd /opt/opencode-remote-control
curl -fsSLO https://raw.githubusercontent.com/batrjan/opencode-remote-control/main/relay/docker-compose.yml
# Create .env (no API key needed — registration is public + rate-limited,
# session deletion requires the session's own bridge token):
echo "PORT=8080" > .env
```

## nginx (install AND every update — the pipeline does not ship it)

> **`nginx/` is not delivered by any deploy step.** The workflow's one `scp`
> copies `relay/` (`.github/workflows/deploy.yml`, "Ship the build context"):
> the host builds the image with that directory as the build context and copies
> its `docker-compose.yml` into `/opt`. Nothing reads, copies,
> tests or reloads `nginx/`. **A change to either file below reaches production
> only when a human repeats the copy on the host.** A green deploy says nothing
> about it: the relay restarts, `/health` is fine, and the edge is still running
> whatever was last copied there by hand.

Two files, and the order matters. The vhost references rate-limit zones that
must be defined in the `http` context, so the `conf.d` file has to be installed
**first** — `nginx -t` fails with `[emerg] unknown limit_req_zone "oc_activate"`
otherwise. `nginx.conf` includes `conf.d/*.conf` before `sites-enabled/*`,
which is what makes this order work at all.

| Repository file | Installed at |
| --------------- | ------------ |
| `nginx/conf.d/opencode-remote-control-limits.conf` | `/etc/nginx/conf.d/opencode-remote-control-limits.conf` |
| `nginx/opencode.b4tr.net.conf` | `/etc/nginx/sites-available/opencode.b4tr.net` (symlinked into `sites-enabled/`) |

From a checkout on the relay host (`~/rc-build/<sha>/` holds only `relay/`, so
clone or copy the repo yourself, or paste the files):

```bash
sudo cp nginx/conf.d/opencode-remote-control-limits.conf /etc/nginx/conf.d/
sudo cp nginx/opencode.b4tr.net.conf /etc/nginx/sites-available/opencode.b4tr.net
sudo ln -s /etc/nginx/sites-available/opencode.b4tr.net /etc/nginx/sites-enabled/   # first install only
sudo nginx -t && sudo systemctl reload nginx
```

The last line is the safety net for the ordering above: a vhost whose zones are
missing fails `nginx -t`, and the reload then does not happen, so the edge keeps
serving the old config rather than breaking.

To see whether the host is current, diff what is installed against the
repository — this is the check to run after any release that touched `nginx/`:

```bash
sudo diff -u /etc/nginx/conf.d/opencode-remote-control-limits.conf \
  nginx/conf.d/opencode-remote-control-limits.conf
sudo diff -u /etc/nginx/sites-available/opencode.b4tr.net nginx/opencode.b4tr.net.conf
```

**This release changes both files** (the `/bridge` shield: the `$http_upgrade`
guard and the `oc_bridge` / `oc_bridge_conn` zones), so both copies are
required. Until they are made, `GET https://<relay>/bridge` is answered by the
relay rather than by nginx — which is how to check it from anywhere:

```bash
curl -sS -D- -o /dev/null https://opencode.b4tr.net/bridge
# nginx has the shield:   Content-Type: application/json           (no charset, no ETag)
# express is answering:   Content-Type: application/json; charset=utf-8, ETag: W/"15-…"
```

What the vhost adds beyond TLS termination:

| Directive | Why |
| --------- | --- |
| `client_max_body_size 25m` (server), `64k` on `/api/activate` and `/api/sessions` | nginx's 1 MB default capped a viewer's prompt long before the relay's own 25 MB limit; the public endpoints are cut the other way, since a registration is a few hundred bytes. The server value is the relay's own limit exactly (`RELAY_PROXY_BODY_LIMIT_BYTES`), because nginx buffers a request body whole before the relay sees any of it: anything it admitted above that limit would be spooled here only for the relay to answer 413. Raise both together or neither. |
| `limit_req zone=oc_activate` (120 r/m, burst 40), `oc_register` (60 r/m, burst 10), `oc_general` (200 r/s, burst 400), `oc_bridge` (30 r/m, burst 30) | A code-guessing flood is stopped at the edge instead of costing the relay a hash and a one-second timer per attempt. The relay's per-share lock (five wrong codes in a row, from any address) is still the security control; this is the shield in front of it, and the only per-address limit on activation. The zone sits on `location = /api/activate`, an exact, case-sensitive match; the relay activates at exactly that path and answers 404 to any other spelling (`/API/activate`, `/api/activate/`), so no activation reaches the relay through `oc_general` instead. |
| `limit_conn oc_conn 256` | One client cannot park thousands of SSE sockets. |
| `location = /bridge`: a 404 for anything that is not a WebSocket handshake, then `oc_bridge` + `limit_conn oc_bridge_conn 32` | This location is only ever the bridge's socket, but an exact match beats the `/` prefix, so before the guard it was the one way around `oc_general`: a single address could pour plain HTTP straight through to Node. nginx answers those itself now (the `return` runs before `limit_req`, so the flood never becomes a request Node sees). The numbers apply to handshakes only, so they are deliberately loose: 30 a minute with a burst of 30 passes a whole office redialling at once after a relay restart, and 32 concurrent sockets per address is far above the one a bridge holds. A bridge treats 429 as a retryable transport error and comes back with backoff — only 401/403 end a share. |

`events { worker_connections }` in `nginx.conf` also wants raising from
Ubuntu's default 768 — every viewer tab holds two SSE connections open.

One note on the name you give the relay in `server_name`: `POST /api/leave`
used to answer with `Clear-Site-Data: "cookies"`, and the specification defines
that directive over the whole **registrable domain**, so a relay at
`opencode.example.com` cleared cookies for every other service under
`example.com`. It no longer sends that directive — only `"cache"` and
`"storage"`, which are scoped to this host and this origin — so a shared parent
domain is safe again. Give the relay a host of its own regardless: everything
else a viewer's browser stores for it (its IndexedDB drafts, its localStorage)
is per origin, and a share ending wipes that origin's storage for every other
share opened in the same browser.

## Deploy

Push to `main` triggers the GitHub Actions workflow. It gates on the tests and
it undoes itself when the new container does not come up:

1. **Test.** The deploy job `needs` a first job that calls `ci.yml`: the relay
   and bridge suites, `tsc --noEmit` for both, and the check that the committed
   bridge bundle matches `bridge/src`. Anything red stops the run before the
   host is touched. `ci.yml` is *called*, not copied, so the check a reviewer
   approved on the PR is the same check the deploy waits on.
2. **Ship.** `relay/` is copied to `~/rc-build/<sha>/` with the runner's own
   `scp`. Both SSH steps used to be third-party actions (`appleboy/scp-action`,
   `appleboy/ssh-action`). They were pinned by commit SHA, but that pins only
   the checkout: one is a docker action built from a movable image tag, the
   other downloads a release binary at runtime without checking a hash, and
   both were handed `SSH_PRIVATE_KEY`. Plain `ssh`/`scp` keeps the key inside
   steps this repository can read end to end.
3. **Tag the outgoing image.** The running `relay-local:amd64` is tagged
   `relay-local:rollback-<YYYYmmdd-HHMMSS>` *before* the build moves the tag —
   that image is what step 6 restores. A fresh host has no previous image, so
   such a deploy logs that it has no rollback target.
4. **Build and restart.** The host runs `docker build` itself, then
   `docker compose up -d --force-recreate relay`.
5. **Health check.** Poll `http://127.0.0.1:$PORT/health` 20 times, 3 s apart
   (~1 minute), until the new container answers. The port is read from
   `/opt/opencode-remote-control/.env` on the host, defaulting to 8080, so a
   relay moved off 8080 is not reported dead by its own deploy.
6. **Roll back if it never answers.** The workflow dumps the failed
   container's logs, points `relay-local:amd64` back at the rollback tag (so a
   later bare `docker compose up` on the host cannot resurrect the broken
   build), recreates the container from that tag, and waits for *it* to pass
   the same health check. The job then fails whatever the outcome — what was
   pushed is not what is running — and the image/context cleanup is skipped on
   this path so the rollback tags survive for inspection. Two cases still need
   hands on the host, and both say so loudly in the log: a rollback that is
   itself unhealthy, and a first deploy — no previous image exists, so there is
   nothing to roll back to and production is left on the broken build.
7. **nginx, by hand, if the release touched it.** The pipeline ships no part of
   `nginx/`, and the deploy is green either way, so this step is yours:

   ```bash
   git diff --stat <previously deployed sha>..HEAD -- nginx/
   ```

   Anything in that output means repeating the two `cp` from
   [nginx](#nginx-install-and-every-update--the-pipeline-does-not-ship-it)
   followed by `sudo nginx -t && sudo systemctl reload nginx`, on the host. The
   order is safe on its own: a vhost whose zones are missing fails `nginx -t`
   and the reload does not run.

The job is bounded at `timeout-minutes: 30` and its ssh alias sets
`ConnectTimeout 15` / `ServerAliveInterval 30` / `ServerAliveCountMax 6`. Both
are about the queue rather than the run: this job holds the `deploy-relay`
concurrency group, so a connection that hangs with the host still answering TCP
used to keep every later push waiting for GitHub's 360-minute default. A deploy
that hits the 30 minutes is a failed deploy, not a slow one — a cold build is
about six minutes — and the rollback did not run, so check what the host is
doing before pushing again.

No registry is involved, so the only secrets needed are the four SSH ones above.

The host builds the image itself and `docker-compose.yml` defaults to it:

```yaml
image: ${RELAY_IMAGE:-relay-local:amd64}
```

A clean checkout has `relay/public/index.html` and `join.html` but NOT the
~84 MB of built UI assets those two pages load (`relay/.gitignore` drops
`public/*` except them), so the image has to build the opencode web UI from the
pinned upstream ref inside Docker. Building by hand on the host is exactly what
the workflow runs:

```bash
cd "$HOME/rc-build/<sha>/relay" && docker build --pull \
  --build-arg UI_SOURCE=source -t relay-local:amd64 .
```

`UI_SOURCE=prebuilt` is for a machine where those assets already exist on disk
**and** the builder is BuildKit, which skips the stage it did not select. The
relay host has no buildx plugin, so its classic builder runs every stage and
`prebuilt` buys nothing there while producing an image whose `public/` is two
HTML pages — `/health` stays green and the web UI is a blank page asking for
`/assets/…` that answers 404.

> Earlier revisions pushed the image to GHCR and had the host pull it. That
> push fails with `denied: permission_denied: write_package` — the package is
> not writable by the repository's `GITHUB_TOKEN` — and every deploy after that
> broke silently left production on an old image. To go back to a registry,
> fix the package's Actions access first (repository → role Write), then point
> the `RELAY_IMAGE` the workflow passes (`.github/workflows/deploy.yml`) at the
> registry tag — setting it in the host's `.env` alone is not enough, since the
> deploy's own assignment overrides that file.

## Base image (`NODE_IMAGE`) and what the runtime image carries

`relay/Dockerfile` pins its base by digest, in a single `ARG NODE_IMAGE` all
three stages share, and the deploy builds with `docker build --pull`. Both
halves matter: the host's daemon used to resolve `node:22-slim` from its own
cache, and thirty-one deploy logs across eleven days show the same base layer
with not one `Pulling from library/node` — the tag looked like it tracked
upstream and tracked nothing. They are not the same protection, though:
the digest is what makes the base reproducible — it names the bytes, so a cache
and a registry have to answer it with the same image — and `--pull` is what
fails the build loudly if the registry no longer serves that digest, and what
fetches it on a host that does not have it yet. The cost of the second half is
that a registry the host cannot reach now fails the deploy even when the layer
is already on disk.

The pin has to be moved by hand, which is the point: nothing changes under
production without a commit. Read the digest the tag points at today and
replace the one in the Dockerfile. The relay host's docker is Ubuntu's package
and has **no buildx plugin** (`docker buildx version` → `unknown command`), so
the second form is the one that works there; the Dockerfile carries both:

```bash
docker buildx imagetools inspect node:22-slim | head -2    # anywhere with buildx
T=$(curl -s 'https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/node:pull' \
  | sed 's/.*"token":"\([^"]*\)".*/\1/')
curl -sI -H "Authorization: Bearer $T" \
  -H 'Accept: application/vnd.oci.image.index.v1+json' \
  https://registry-1.docker.io/v2/library/node/manifests/22-slim | grep -i docker-content-digest
```

**Bumping that digest is the only thing that patches the OS.** The final stage
runs `apt-get upgrade`, and bumping the base invalidates every layer below it
so that upgrade re-runs — but between bumps nothing above it changes, the layer
is a cache hit, and the deploy keeps the cache deliberately (it does not prune,
or the next build would rebuild the web UI from source). A redeploy is not a
patch. Treat the bump as a scheduled task, **monthly and on any Debian or Node
security advisory that names the base**: read the digest, commit it, push, and
the deploy that follows rebuilds the image from the new base.

A trivy scan of the image production was running found 225 OS CVEs (4 CRITICAL,
55 HIGH) and 19 more inside the npm CLI that ships in the base image; the
relay's own `node_modules` scanned clean. npm, npx and corepack are therefore
deleted from the final stage — the container runs `node dist/index.js` and its
healthcheck is `node -e …`, so nothing at runtime ever calls them.

Dependabot cannot do this bump for us, so the repository has no
`.github/dependabot.yml` for it: its docker updater reads literal `FROM` lines
and does not resolve build arguments, and all three stages here are
`FROM ${NODE_IMAGE}` — one ARG so the stages cannot drift onto different bases,
which is worth more than the automation. A `package-ecosystem: docker` entry
against this Dockerfile would find nothing, for ever, and say nothing about it,
which is worse than no entry at all. Automating it means moving the image back
into a literal `FROM` (and accepting that the three stages can then drift), so
until that trade is made, the calendar above is the mechanism.

The build frontend is pinned the same way — by not being requested. There is no
`# syntax=` line: it named `docker/dockerfile:1`, a movable tag, and BuildKit
fetches that image before the build begins, outside `--pull` — so wherever
BuildKit parses this file (CI, a developer's machine) the earliest link in the
chain was also the only unpinned one. On the relay host it was never resolved
at all: that host has no buildx plugin, `docker build` falls back to the classic
builder, and the classic builder ignores `# syntax=` (the image production runs
today was built from a Dockerfile that still carried the line, and
`docker history relay-local:amd64` shows plain `#(nop)` layers with no
`buildkit.dockerfile.v0` comment). Dropping the directive therefore costs
nothing here and pins the frontend everywhere else. Nothing in the Dockerfile
needs a frontend newer than the one BuildKit ships with; if a future edit does
(`RUN --mount`, heredocs, `COPY --link`), add the directive back **with a
digest**, `# syntax=docker/dockerfile:1@sha256:…`, and bump it here alongside
`NODE_IMAGE`.

That the host still builds with the legacy builder is itself a thing to fix on
a calendar: `docker build --help` there prints "DEPRECATED: The legacy builder
is deprecated and will be removed in a future release". Installing
`docker-buildx-plugin` is a separate, deliberate change — after it, `# syntax=`
starts to mean something on this host and its absence becomes a real
protection, and the `UI_SOURCE` note above stops being a trap.

## Client IP behind nginx (`RELAY_TRUST_PROXY`)

The registration caps (12 registrations an hour and 5 active shares per
address) key on the client address express derives from `X-Forwarded-For`, and
so does the address in every `[activate]` log line, so the relay must trust
exactly the hop nginx uses. Activation itself is not limited per address — its
brake is the per-share lock, which counts wrong codes from every address alike
— so this setting does not decide who can join. In Docker that hop is the
bridge gateway (`172.18.0.1`), **not** loopback — with the old hard-coded
`loopback` the header was ignored and every client collapsed into one address:
the whole service shared a single IP's registration budget and five-share cap
(and, back when activation still had a per-address limit, five wrong codes
from anyone locked activation for everyone). Compose therefore sets
`RELAY_TRUST_PROXY=loopback, uniquelocal`. The port is published on
`127.0.0.1` only, so a private-range peer can only be the host's nginx, and
nginx must append the real address (`proxy_set_header X-Forwarded-For
$proxy_add_x_forwarded_for`, as in `nginx/opencode.b4tr.net.conf`) — express
takes the right-most untrusted hop, so a client-supplied prefix is ignored.
Verify after a deploy: a wrong code from your machine must log your public
address, not `172.x`:

```bash
docker compose logs --tail 20 relay | grep '\[activate\]'
```

The deploy workflow also copies `relay/docker-compose.yml` to
`/opt/opencode-remote-control/` on every run, so the host compose file can
no longer drift from the repository.

This setting does **not** affect the CSRF guard on state-changing proxy POSTs.
That guard compares the Origin's host with the `Host` header and ignores the
scheme, so `X-Forwarded-Proto` is not required for it and a proxy that
forwards `Host: relay.example:443` is fine. If a share's GETs work but sending
a prompt, aborting or answering a permission returns 403, the relay logs one
`[proxy] cross-origin POST refused` line naming both the Origin and the `Host`
it was compared against — usually a proxy rewriting `Host` to something the
browser never saw.

## Session cap (`RELAY_MAX_SESSIONS`)

The relay holds at most `RELAY_MAX_SESSIONS` shares at once, 2,000 by default,
whoever registered them. Registration is public and the other caps are per
address, so without a total a pool of addresses could grow the session set —
all of it in memory, up to ~5 KB per share plus its viewers, and rewritten to
the state file on every change — without end.

A registration that finds the relay full first drops the registrations no
bridge connected to within 5 minutes, then takes the slot of the share whose
bridge has been gone longest, once that bridge has been gone for more than
5 minutes (a laptop closed, a network that dropped). A share whose bridge is
connected is never ended. The bridge of an ended share is refused with 401 when
it comes back and stops; its owner runs `/remote-control/start` again and gets
the same link with a new code. Only when neither frees a slot is the
registration answered `503 {"error":"relay full"}`. The relay logs both:

```bash
docker compose logs relay | grep RELAY_MAX_SESSIONS
```

```
[store] relay full: ended share session="ses_…" (no live bridge for 47 min) to make room (RELAY_MAX_SESSIONS)
[sessions] registration refused: relay holds 2000 sessions (RELAY_MAX_SESSIONS)
```

Such lines on a relay that is merely busy mean the cap is too low for it: set
`RELAY_MAX_SESSIONS` in `.env` (compose passes the whole file to the
container) and recreate the container. With `RELAY_STATE_KEY` unchanged the
live shares survive the restart (see [Session state](#session-state-volume)).

```bash
docker compose up -d --force-recreate relay
```

## Session state (volume)

The relay keeps its sessions in memory, so a plain restart would end every live
share: viewer cookies and bridge tokens become invalid while the bridges are
still running. `docker-compose.yml` therefore mounts a named volume and points
`RELAY_STATE_FILE` at it:

```yaml
environment:
  RELAY_STATE_FILE: "${RELAY_STATE_FILE:-/data/state.json}"
volumes:
  - relay-state:/data
```

The plaintext access code, bridge token and viewer tokens are never stored —
the store only ever holds salted hashes. The file itself is **encrypted at
rest** (AES-256-GCM) with `RELAY_STATE_KEY`, a key kept in `.env` on the host
(NOT in the state volume), so a copy of the volume — a backup, a `docker cp`, a
snapshot — is useless without the key. The deploy workflow generates the key on
first run:

```bash
grep -q '^RELAY_STATE_KEY=' .env || echo "RELAY_STATE_KEY=$(openssl rand -hex 32)" >> .env
```

With a key, a redeploy keeps every live share AND its unused join code working.
Without a key the file is plaintext and the code hash / owner IP are stripped
before writing (the safe fallback: a redeploy then invalidates an unused code).
The rate-limit counters are never persisted. Leaving `RELAY_STATE_FILE` empty
restores the old in-memory-only behaviour.

Switching a relay that has been running without a key TO one is only safe with
no live shares. A keyed relay cannot tell a pre-encryption leftover from a file
forged by someone who can write the volume but does not know the key, so it
treats every plaintext file as a forgery, sets it aside and starts empty:

```
[persist] ignoring /data/state.json: plaintext state file but RELAY_STATE_KEY is set …
```

Every live share ends at once, exactly as it would on a changed key (below).
Either wait for a window with no active shares, or convert the file first: read
the plaintext and write it back as an AES-256-GCM envelope under the new key.
The recovery below does not apply to this case — the file set aside is
plaintext, so a keyed relay only sets it aside again; it can be restored only
with `RELAY_STATE_KEY` removed. Going the other way, taking the key away from a
relay that has one, is just as destructive and always has been.

Shares survive a redeploy only while `RELAY_STATE_KEY` stays the same. Rotating
the key (e.g. after exposure) ENDS EVERY LIVE SHARE, and so does a relay started
with a different key or none by mistake (a lost or hand-edited `.env`, a new
host, `docker compose` run from another directory). Such a relay cannot
decrypt the old file, starts empty and says so in its log:

```
[relay] session state: /data/state.json (encrypted)
[persist] ignoring /data/state.json: could not decrypt (wrong RELAY_STATE_KEY or tampered file). …
[relay] restored 0 session(s)
```

`/health` stays green, so the deploy's health check does not catch it. Nothing
re-registers: each running bridge re-dials, is refused with 401 because the
relay no longer knows its session, and exits. Every owner has to run
`/remote-control/start` again and hand out the new link and code.

The relay also survives errors that escape their own call stack rather than
dying of them (one process serves every tenant's share, so an exit would end
them all). Those are counted: `faults.swallowed` in the `/health` body, with
`faults.last_at`, alongside the `[relay] uncaught exception` / `[relay]
unhandled rejection` lines in the container log. The probe stays green on
purpose — a restart would cost every live share over an error the relay
declared survivable — so a counter that climbs between deploys is the thing to
alert on, not the health check.

Run it **on the host**, and not through nginx — that is what gets you the
counter at all. `/health` is public (it is served from the general `location /`;
there is no `location = /health`), and a number that moves when a handler throws
would tell any anonymous caller whether their own probe had found a bug, so the
relay leaves `faults` out of the body for anything arriving with the
`X-Forwarded-For` nginx appends to. Everything else about the answer is the same
for everyone:

```bash
curl -fsS http://127.0.0.1:8080/health   # {"ok":true,…,"faults":{"swallowed":0}}
curl -fsS https://opencode.b4tr.net/health   # same body without "faults"/"claims"
```

The same body carries `claims` on that side: `{ held, refused }` for the map
that keeps an ended share's id reserved for the install that shared it. A
`refused` that moves means the map is full and ids are no longer being kept —
worth an alert of its own, because nothing else says so: the registrant is not
refused, only the reservation behind their id is, and the relay repeats the
line in the container log at most once an hour.

And `events_dropped`: `{ "<event kind>": <count> }` for the opencode events a
viewer's stream withheld because they carry no session id and the kind is not
one a viewer needs (see "What a viewer does NOT see" in the README). It is not
an alert — a busy owner moves those counters all day — it is the answer to a
report that some panel in the viewer's UI never updates. Look for a kind there
that sounds like the panel; if one belongs on the list, it goes in
`GLOBAL_EVENT_KINDS` in `relay/src/proxy/adapter.ts` and in the README's table,
which a test keeps in step. The first drop of each kind is also one line in the
container log (`[events] dropping unsessioned event kind=…`), at most one per
kind for the life of the process.

The old file is not destroyed. Until the relay first writes its state (a share
started or joined), it stays where it is, so restarting with the right key in
that window restores it. The first write moves it aside to
`<RELAY_STATE_FILE>.unreadable-<epoch ms>` in the same volume
(`/data/state.json.unreadable-…` by default), logged as
`[persist] moved the unreadable …`. Putting it back (stop the relay, restore the
old key, move the file to `RELAY_STATE_FILE`, start) brings back the sessions
and viewer cookies, but not the bridges that have already exited. Delete it once
it is no longer needed:

```bash
docker compose exec relay sh -c 'rm -f /data/state.json.unreadable-*'
```

To wipe every share (e.g. after a security incident):

```bash
cd /opt/opencode-remote-control
docker compose down
docker volume rm opencode-remote-control_relay-state
docker compose up -d
```

## Container hardening (and the memory limit that is deliberately absent)

`docker-compose.yml` runs the relay as the image's unprivileged `node` user,
publishes 8080 on `127.0.0.1` only and mounts no host paths — and on top of
that:

| Setting | What it takes away |
| ------- | ------------------ |
| `read_only: true` + `tmpfs: /tmp` (`size=64m,mode=1777`) | Nothing in the image can be modified. `/data` (the state file and the temp file it is renamed from) stays writable through its volume, and `/tmp` is a tmpfs because a read-only container without a writable temp directory fails in places that only surface under load. The size matters as much as the tmpfs: without `size=` a tmpfs takes the kernel default of **half the host's RAM** (32 GiB here), charged to the host rather than to the container — and this container deliberately has no `mem_limit`, so under `read_only` that was the one unbounded write path left. Nothing in `relay/src` writes to `/tmp` or `os.tmpdir()`, so 64 MiB is slack, not a budget. |
| `cap_drop: ALL` | The default capability set. The process binds 8080, above 1024, as a non-root user, so it needs none of them. |
| `security_opt: no-new-privileges:true` | A setuid binary in the image as a way to raise privileges. |
| `pids_limit: 256` | A fork bomb inside the container being a fork bomb on the host. One Node process and its threads are far under this. |
| `logging: json-file, max-size 10m, max-file 5` | An attacker choosing how fast the host's disk fills: every wrong access code writes an `[activate]` line, and docker's default json-file driver rotates nothing. |

After a deploy, confirm what is actually running:

```bash
docker inspect -f '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}} {{.HostConfig.PidsLimit}}' \
  "$(docker compose ps -q relay)"
docker inspect -f '{{json .HostConfig.Tmpfs}}' "$(docker compose ps -q relay)"
# {"/tmp":"size=64m,mode=1777"} — `null` means the container predates this and
# is running with a writable root; recreate it.
```

There is **no** `mem_limit`, on purpose. The audit that added the rest of this
table examined one and rejected it: V8 caps its own heap anyway (~4 GB here,
and Node 22 reads a cgroup limit when one exists and sizes the heap under it),
so a cgroup ceiling does not contain a leak — it converts one into an
OOM kill of the single process that holds **every** live share, which is
strictly worse than the slow degradation it replaces. If you add one to
protect other services on the host, set `--max-old-space-size` in step with it
(heap ceiling comfortably under the cgroup limit, room left for buffers and
the C++ heap) rather than leaving V8 to discover the wall by being killed at
it. The per-share budgets in the relay are what bound one viewer's effect on
another; a container limit never was.

## Rollback

A deploy whose new container fails its health check rolls itself back (step 6
above). The manual path below is for the other case: a deploy that came up
healthy and then turned out to be wrong.

Each deploy tags the outgoing image before replacing it, and the three newest
tags are kept:

```bash
ssh "$SSH_USER@$SSH_HOST"
docker images | grep relay-local          # pick a relay-local:rollback-<stamp>
cd /opt/opencode-remote-control
RELAY_IMAGE=relay-local:rollback-<stamp> docker compose up -d --force-recreate relay
curl -fsS http://127.0.0.1:8080/health
```

Put `RELAY_IMAGE` in `.env` to hold the rollback against a manual
`docker compose up` on the host; remove it to return to the freshly built
image. It does **not** hold against a deploy: the workflow runs
`RELAY_IMAGE=relay-local:amd64 docker compose up …`
(`.github/workflows/deploy.yml`), and an assignment in the environment beats
`.env` in compose, so the next push to `main` — anyone's, related to this
incident or not — puts the freshly built image back and reports green. Hold the
rollback in git as well (revert the bad commit, or keep merges to `main` on
hold) until the fix is in. And remember to drop the line from `.env` afterwards:
left there, it sends the next manual `docker compose up` back to the old image.

This rolls back the relay only; owners install the plugin from `main` on their own
machines. A relay with owner keys keeps an ended share's id for the install that shared
it for 30 days, so a plugin rolled back past owner keys (it sends none) is refused a
conversation a newer plugin shared, with a bare `relay createSession failed: 409`, until
then. There is nothing to clear on the relay for it: that conversation is shared from the
newer plugin again, or another one is shared (see
[README.md](README.md#what-sharing-grants)).

A relay rolled back past share resumption is safe in the other direction — it simply
ignores the `access_code` a newer bridge sends and answers with a new one, the way every
registration used to — but while the rollback is up, an owner whose OpenCode died and
started the share again gets a new code and loses the viewers who were watching, instead
of keeping both. The bridge notices nothing: it reads the code the relay answered with.
Restarting the relay itself is not that case; the encrypted state file carries the
sessions, their code hashes and their viewers across it (see
[Session state (volume)](#session-state-volume)).
