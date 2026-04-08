# Deployment guide

This document walks through deploying the LILA Tic-Tac-Toe stack to a
production environment. The cheapest path is **a single $6/mo
DigitalOcean droplet for Nakama + Postgres + Caddy** plus a **free Vercel
deploy for the React frontend**, but the same recipe works on any Linux VM
provider (AWS Lightsail, Hetzner, Linode, Oracle Cloud Free Tier).

The end state is:

```
                  ┌─────────────────────────┐
   Browser ──TLS──│ frontend.example.com    │ (Vercel)
                  │  Vite-built static SPA  │
                  └────────────┬────────────┘
                               │ wss://
                               ▼
                  ┌─────────────────────────┐
                  │ nakama.example.com:443  │ (DigitalOcean droplet)
                  │  Caddy → Nakama :7350   │
                  │  Nakama → Postgres :5432│
                  └─────────────────────────┘
```

---

## 1. Provision a server

Any Ubuntu 22.04+ VM with 1 vCPU and 1 GB RAM is enough for the assignment
load. On DigitalOcean:

1. Create a new droplet (Basic, regular SSD, $6/mo, Ubuntu 22.04 LTS).
2. Add your SSH public key.
3. Enable backups if you care.
4. Note the public IPv4 address — you'll point a DNS A record at it.

SSH in:

```bash
ssh root@<droplet-ip>
```

### Install Docker

```bash
apt update && apt upgrade -y
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker
docker --version
docker compose version
```

### Create a non-root user (recommended)

```bash
adduser lila
usermod -aG docker lila
rsync --archive --chown=lila:lila ~/.ssh /home/lila/
```

From now on use `ssh lila@<droplet-ip>`.

---

## 2. Clone the repo on the server

```bash
cd ~
git clone https://github.com/<your-username>/lila-tictactoe.git
cd lila-tictactoe
```

---

## 3. Set production secrets

Edit `nakama/local.yml` and replace **all** of these placeholder values
with strong random secrets (use `openssl rand -hex 32` to generate):

- `runtime.http_key`
- `session.encryption_key`
- `session.refresh_encryption_key`
- `socket.server_key` (write this down — you'll need it on the frontend)
- `console.username`
- `console.password`

Set the Postgres password via env var instead of editing the compose file:

```bash
echo 'POSTGRES_PASSWORD=$(openssl rand -hex 32)' >> .env
# (or just hand-type a strong password)
```

The `docker-compose.yml` already reads `${POSTGRES_PASSWORD:-localdev}`.

> **Important:** add `local.yml` and `.env` to your local `.gitignore` if
> you're tracking changes — never commit production secrets.

---

## 4. Bring up the stack

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f nakama
```

You should see the same `LILA Tic-Tac-Toe runtime initialized successfully`
message you saw locally. Hit Ctrl-C to detach from the logs (the container
keeps running).

Test the healthcheck RPC:

```bash
curl -s "http://localhost:7350/v2/rpc/healthcheck?http_key=<your-runtime-http-key>"
```

You should get `{"payload":"{\"ok\":true,...}"}`.

---

## 5. Put Caddy in front of port 7350

By default the Nakama HTTP port is plain HTTP. We don't want that — the
browser will refuse a `wss://` connection from a `https://` origin to a
plain `http://` server. Install Caddy and let it handle TLS automatically
via Let's Encrypt:

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

Point a DNS A record at the droplet's IP:

```
nakama.example.com  →  <droplet-ip>
```

Edit `/etc/caddy/Caddyfile`:

```caddy
nakama.example.com {
    encode gzip
    reverse_proxy 127.0.0.1:7350
}
```

> Optional but recommended — also expose the Nakama Console behind basic
> auth on a subdomain:
>
> ```caddy
> console.nakama.example.com {
>     basicauth {
>         admin <hashed-password-from-`caddy hash-password`>
>     }
>     reverse_proxy 127.0.0.1:7351
> }
> ```

Reload Caddy:

```bash
sudo systemctl reload caddy
```

Caddy will automatically request and renew a Let's Encrypt cert for the
host. Within 30 seconds you should be able to hit
`https://nakama.example.com/` from any browser and get a Nakama "404 Not
Found" page (which means it's reverse-proxying correctly — the API paths
all live under `/v2/...`).

### Open the firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80
sudo ufw allow 443
sudo ufw enable
```

Do **not** open ports 7349/7350/7351 directly to the public Internet —
let Caddy be the only public surface.

---

## 6. Deploy the frontend to Vercel

The React app is a static SPA, so any static host works. Vercel is the
fastest path:

1. Push the repo to GitHub.
2. Sign in to <https://vercel.com> with your GitHub account.
3. Import the repo.
4. **Project root:** `frontend`
5. **Framework preset:** Vite (Vercel auto-detects)
6. **Build command:** `npm run build`
7. **Output directory:** `dist`
8. Add the following environment variables:

   | Name                      | Value                                          |
   | ------------------------- | ---------------------------------------------- |
   | `VITE_NAKAMA_HOST`        | `nakama.example.com`                           |
   | `VITE_NAKAMA_PORT`        | `443`                                          |
   | `VITE_NAKAMA_USE_SSL`     | `true`                                         |
   | `VITE_NAKAMA_SERVER_KEY`  | (the value of `socket.server_key`)             |

9. Click Deploy.

After the first deploy you'll have a URL like
`https://lila-tictactoe-<hash>.vercel.app`. Open it on your phone and
desktop simultaneously to play a multiplayer match.

> **Custom domain:** in the Vercel project settings → Domains, add
> `play.example.com` (or whatever you like). Vercel will give you the DNS
> records to add.

---

## 7. Updating

To deploy a new build:

```bash
ssh lila@<droplet-ip>
cd lila-tictactoe
git pull
docker compose up -d --build nakama
```

The frontend redeploys automatically on every push to `main` if you wired
up the Vercel integration.

---

## 8. Backups

The Postgres data lives in the named Docker volume `lila_postgres_data`.
The minimum-viable backup script:

```bash
docker exec lila-postgres pg_dump -U nakama -d nakama | gzip > /home/lila/backups/nakama-$(date +%F).sql.gz
```

Run from cron:

```cron
0 3 * * * /usr/bin/docker exec lila-postgres pg_dump -U nakama -d nakama | gzip > /home/lila/backups/nakama-$(date +\%F).sql.gz
```

For real production: ship the dumps to S3 / Backblaze / Hetzner Storage
Box and rotate weekly.

---

## 9. Rolling back a bad deploy

```bash
git log --oneline -n 5
git checkout <previous-good-sha>
docker compose up -d --build nakama
```

Postgres state is sticky between rebuilds, so the runtime will pick up
where it left off. If a TypeScript change broke the schema in some way you
can also restore from the most recent dump:

```bash
gunzip -c /home/lila/backups/nakama-2024-11-09.sql.gz | docker exec -i lila-postgres psql -U nakama -d nakama
```

---

## 10. Costs

| Item                                 | Approx monthly |
| ------------------------------------ | -------------- |
| DigitalOcean basic droplet (1GB)     | $6             |
| Vercel Hobby (frontend)              | $0             |
| Domain name                          | ~$1            |
| **Total**                            | **~$7**        |

Comfortable headroom for the kind of load this assignment generates.
