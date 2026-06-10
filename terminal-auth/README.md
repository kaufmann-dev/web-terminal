# Private Browser Terminal

A secure, minimal web application that protects a browser-based terminal (`ttyd`) behind email/password authentication. Deployed at `https://terminal.kaufmann.dev`.

## Overview

- **Auth app** (Node.js/Express) handles login, sessions, CSRF protection, rate limiting, and reverse-proxies `ttyd`.
- **ttyd** runs on `127.0.0.1:7681` only and is never exposed to the public internet.
- **Reverse proxy** (Caddy or Nginx) terminates TLS and forwards traffic to the auth app.
- A single admin user is configured via environment variables.

## Security Model

> **Warning:** Exposing a browser-based terminal is inherently sensitive. A compromised session or authentication bypass may grant shell access to your server. Follow the hardening steps below and keep the host OS, kernel, and dependencies up to date.

- ttyd binds to **127.0.0.1** only.
- The auth app is the **only public entry point**.
- Passwords are hashed with **Argon2id**.
- Sessions use **HTTP-only, Secure, SameSite=Lax** cookies.
- **CSRF tokens** protect state-changing endpoints (`/login`, `/logout`).
- **Rate limiting** and brute-force protection throttle login attempts.
- **Helmet** sets security headers; **CSP** and **frame-ancestors** prevent clickjacking.
- ttyd runs as an unprivileged **`terminal`** user with a restricted home directory.

## Project Structure

```
terminal-auth/
├── app.js                      # Express app with auth + ttyd proxy
├── package.json
├── .env.example                # Example environment variables
├── .env                        # Production secrets (not in git)
├── scripts/
│   └── hash-password.js        # Generate AUTH_PASSWORD_HASH
├── views/
│   ├── login.html              # Dark login page
│   └── terminal.html           # Full-screen terminal iframe
├── public/css/
│   └── style.css               # Minimal dark styles
├── deploy/
│   ├── terminal-auth.service   # systemd service for the app
│   ├── ttyd.service            # systemd service for ttyd
│   └── Caddyfile               # Example Caddy reverse proxy
└── README.md                   # This file
```

## Requirements

- Linux VPS (Ubuntu/Debian recommended)
- Node.js 18+
- `ttyd` binary installed (see https://github.com/tsl0922/ttyd)
- Caddy or Nginx for reverse proxy + TLS
- Dedicated unprivileged user (`terminal`) for the shell session

## Installation

### 1. Create the terminal user

```bash
sudo useradd -m -s /bin/bash -d /home/terminal terminal
sudo mkdir -p /home/terminal
sudo chown terminal:terminal /home/terminal
```

Do **not** give this user passwordless sudo or root privileges.

### 2. Install ttyd

Download the latest release for your platform:

```bash
wget https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 -O /usr/local/bin/ttyd
chmod +x /usr/local/bin/ttyd
```

### 3. Deploy the auth app

```bash
sudo mkdir -p /opt/terminal-auth
sudo chown $USER:$USER /opt/terminal-auth
cd /opt/terminal-auth
git clone <this-repo> .
npm install --production
```

### 4. Configure environment variables

```bash
cp .env.example .env
nano .env
```

Required variables:

| Variable | Description |
|----------|-------------|
| `AUTH_EMAIL` | Admin email address |
| `AUTH_PASSWORD_HASH` | Argon2id hash of the admin password |
| `SESSION_SECRET` | Long random string (≥32 chars) for session signing |
| `TTYD_URL` | `http://127.0.0.1:7681` (default) |
| `PORT` | Port the auth app listens on (default `3000`) |
| `NODE_ENV` | `production` |
| `TRUST_PROXY` | `true` when running behind a reverse proxy |

Generate a password hash:

```bash
node scripts/hash-password.js 'YourStrongPassword!'
```

Copy the printed hash into `.env` as `AUTH_PASSWORD_HASH`.

### 5. Start services

#### ttyd

Copy the systemd service file and start ttyd:

```bash
sudo cp deploy/ttyd.service /etc/systemd/system/ttyd.service
sudo systemctl daemon-reload
sudo systemctl enable --now ttyd
```

Verify ttyd is listening on localhost only:

```bash
ss -tlnp | grep 7681
```

#### Auth app

```bash
sudo cp deploy/terminal-auth.service /etc/systemd/system/terminal-auth.service
sudo systemctl daemon-reload
sudo systemctl enable --now terminal-auth
```

Check status:

```bash
sudo systemctl status terminal-auth
```

### 6. Configure the reverse proxy

#### Caddy

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Make sure the Caddyfile points `terminal.kaufmann.dev` to `localhost:3000`. Caddy handles WebSocket upgrades automatically.

#### Nginx (alternative)

If you prefer Nginx, here is a minimal site config:

```nginx
server {
    listen 443 ssl http2;
    server_name terminal.kaufmann.dev;

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket support
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

### 7. Firewall assumptions

- **Allow:** HTTPS (`443`) from anywhere.
- **Allow:** SSH (`22`) from your admin IP(s) only.
- **Deny:** direct access to port `3000` and `7681` from the public internet.

Example with `ufw`:

```bash
sudo ufw default deny incoming
sudo ufw allow 22/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

### 8. Health check

```bash
curl -f https://terminal.kaufmann.dev/health
```

Expected response:

```json
{"status":"ok","timestamp":"..."}
```

## Updating the admin password

1. Generate a new hash:
   ```bash
   node scripts/hash-password.js 'NewPassword'
   ```
2. Update `AUTH_PASSWORD_HASH` in `.env`.
3. Restart the auth app:
   ```bash
   sudo systemctl restart terminal-auth
   ```

## Logging & Monitoring

View logs:

```bash
sudo journalctl -u terminal-auth -f
sudo journalctl -u ttyd -f
```

## Logout

Click the **Logout** button in the top-right of the terminal page. This destroys the server-side session and clears the cookie.

## Development / Local Testing

```bash
cd terminal-auth
cp .env.example .env
# Edit .env and set SESSION_SECRET and a test password hash
npm install
npm start
```

Open `http://localhost:3000`. Note: for local testing you may want `NODE_ENV=development` and `TRUST_PROXY=false` so cookies work without HTTPS.

## Troubleshooting

- **WebSocket connection fails:** Ensure the reverse proxy forwards `Upgrade` and `Connection` headers. Caddy does this by default; Nginx requires explicit configuration.
- **Session cookie not set:** Ensure `TRUST_PROXY=true` when behind a reverse proxy and that HTTPS is used in production (`Secure` cookies require HTTPS).
- **ttyd 502 error:** Verify ttyd is running and listening on `127.0.0.1:7681`. Check `sudo systemctl status ttyd`.
- **Permission denied:** Ensure the auth app and ttyd run as the `terminal` user and that file paths in systemd units are correct.

## License

Private project. Not licensed for redistribution.
