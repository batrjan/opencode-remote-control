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

```bash
sudo cp nginx/opencode.b4tr.net.conf /etc/nginx/sites-available/
sudo ln -s /etc/nginx/sites-available/opencode.b4tr.net.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

## Deploy

Push to `main` triggers the GitHub Actions workflow: ship `relay/` to the host
over SSH → `docker build` there → `docker compose up -d --force-recreate relay`
→ wait for `/health`. No registry is involved, so the only secrets needed are
the three SSH ones above.

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

## Rollback

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
