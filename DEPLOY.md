# Deployment: opencode-remote-control relay

All server-specific values (host, SSH user, paths) are intentionally NOT stored
in this repository. Configure them as secrets/variables in your environment.

## GitHub Secrets (required)

Set these in the repo's Settings → Secrets and variables → Actions:

- `SSH_HOST` — your relay server hostname or IP
- `SSH_USER` — your SSH user on that server
- `SSH_PRIVATE_KEY` — the private key for that user (deploy key)

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

## nginx (one-time)

The vhost references rate-limit zones that must be defined in the `http`
context, so the `conf.d` file has to be installed **first** — `nginx -t` fails
with `[emerg] unknown limit_req_zone "oc_activate"` otherwise. `nginx.conf`
includes `conf.d/*.conf` before `sites-enabled/*`, which is what makes this
order work at all.

```bash
sudo cp nginx/conf.d/opencode-remote-control-limits.conf /etc/nginx/conf.d/
sudo cp nginx/opencode.b4tr.net.conf /etc/nginx/sites-available/opencode.b4tr.net
sudo ln -s /etc/nginx/sites-available/opencode.b4tr.net /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

What the vhost adds beyond TLS termination:

| Directive | Why |
| --------- | --- |
| `client_max_body_size 32m` (server), `64k` on `/api/activate` and `/api/sessions` | nginx's 1 MB default capped a viewer's prompt long before the relay's own 25 MB limit; the public endpoints are cut the other way, since a registration is a few hundred bytes. |
| `limit_req zone=oc_activate` (120 r/m, burst 40), `oc_register` (60 r/m, burst 10), `oc_general` (200 r/s, burst 400) | A code-guessing flood is stopped at the edge instead of costing the relay a hash and a one-second timer per attempt. The relay's per-share lock (five wrong codes in a row, from any address) is still the security control; this is the shield in front of it, and the only per-address limit on activation. The zone sits on `location = /api/activate`, an exact, case-sensitive match; the relay activates at exactly that path and answers 404 to any other spelling (`/API/activate`, `/api/activate/`), so no activation reaches the relay through `oc_general` instead. |
| `limit_conn oc_conn 256` | One client cannot park thousands of SSE sockets. |
| No limits on `location = /bridge` | One long-lived socket per share; throttling a reconnect storm would keep shares down rather than protect anything. |

`events { worker_connections }` in `nginx.conf` also wants raising from
Ubuntu's default 768 — every viewer tab holds two SSE connections open.

## Deploy

Push to `main` triggers the GitHub Actions workflow. It gates on the tests and
it undoes itself when the new container does not come up:

1. **Test.** The deploy job `needs` a first job that calls `ci.yml`: the relay
   and bridge suites, `tsc --noEmit` for both, and the check that the committed
   bridge bundle matches `bridge/src`. Anything red stops the run before the
   host is touched. `ci.yml` is *called*, not copied, so the check a reviewer
   approved on the PR is the same check the deploy waits on.
2. **Ship.** `relay/` is copied to `~/rc-build/<sha>/` over SSH.
3. **Tag the outgoing image.** The running `relay-local:amd64` is tagged
   `relay-local:rollback-<YYYYmmdd-HHMMSS>` *before* the build moves the tag —
   that image is what step 6 restores. A fresh host has no previous image, so
   such a deploy logs that it has no rollback target.
4. **Build and restart.** The host runs `docker build` itself, then
   `docker compose up -d --force-recreate relay`.
5. **Health check.** Poll `http://127.0.0.1:8080/health` 20 times, 3 s apart
   (~1 minute), until the new container answers.
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

No registry is involved, so the only secrets needed are the three SSH ones above.

The host builds the image itself and `docker-compose.yml` defaults to it:

```yaml
image: ${RELAY_IMAGE:-relay-local:amd64}
```

A clean checkout has no `relay/public` (the UI assets are gitignored), so the
image builds the opencode web UI from the pinned upstream ref inside Docker
(`--build-arg UI_SOURCE=source`). Building locally where those assets do exist
is faster with `UI_SOURCE=prebuilt`.

> Earlier revisions pushed the image to GHCR and had the host pull it. That
> push fails with `denied: permission_denied: write_package` — the package is
> not writable by the repository's `GITHUB_TOKEN` — and every deploy after that
> broke silently left production on an old image. To go back to a registry,
> fix the package's Actions access first (repository → role Write) and point
> `RELAY_IMAGE` in the host's `.env` at the registry tag.

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

Put `RELAY_IMAGE` in `.env` to make a rollback survive the next
`docker compose up`; remove it to return to the freshly built image.
