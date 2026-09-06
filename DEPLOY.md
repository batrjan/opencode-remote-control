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

```bash
cd /opt/opencode-remote-control
git clone https://github.com/batrjan/opencode-remote-control.git .
# or rsync the repo
# Create .env:
echo "RELAY_API_KEY=$(openssl rand -hex 32)" > .env
echo "PORT=8080" >> .env
```

## nginx (one-time)

```bash
sudo cp nginx/opencode.b4tr.net.conf /etc/nginx/sites-available/
sudo ln -s /etc/nginx/sites-available/opencode.b4tr.net.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

## GHCR authentication (server)

```bash
docker login ghcr.io -u <github-user> -p <github-pat-with-read:packages>
```

## Deploy

Push to `main` triggers the GitHub Actions workflow: build → push GHCR → SSH deploy.

## Rollback

```bash
cd /opt/opencode-remote-control
docker compose pull
docker compose up -d --force-recreate relay
# or set RELAY_IMAGE to a specific sha:
# RELAY_IMAGE=ghcr.io/batrjan/opencode-remote-control/relay:<sha> docker compose up -d
```
