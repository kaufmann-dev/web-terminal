# Private Browser Terminal

A private, password-protected terminal you can open in a web browser. One admin account signs in through a secure login page, then uses a full shell powered by `ttyd`.

> **Security warning:** A browser terminal can run shell commands in its deployment container. Protect it with HTTPS, strong credentials, and restricted network access. This Coolify setup does not provide a shell on the Coolify host.

## Coolify Deployment

### 1. Create the application

Connect this repository to a new Coolify application and use these settings:

- **Build Pack:** Nixpacks
- **Base Directory:** `/`

The included Nixpacks configuration installs `ttyd` and starts it privately alongside the web application. The deployment is not a static site and needs no pre- or post-deployment command.

### 2. Set the environment variables

Required:

- `AUTH_EMAIL` — the email address used to sign in.
- `AUTH_PASSWORD` — the long, unique password used to sign in; the app hashes it automatically at startup.
- `SESSION_SECRET` — a unique random string of at least 32 characters.
- `TRUST_PROXY` — set to `true` so secure session cookies work behind Coolify's HTTPS proxy.

Optional:

- `NODE_ENV` — defaults to `production`.
- `TTYD_URL` — defaults to `http://127.0.0.1:7681`, which matches the bundled terminal process.

Coolify supplies `PORT` automatically; do not set a fixed port.

### 3. Deploy and sign in

Deploy the application, open its Coolify domain, and sign in with `AUTH_EMAIL` and `AUTH_PASSWORD`.

Check `https://your-domain.example/health` if you want to confirm that the web application is responding.

## Everyday Use

- Click **Logout** when you finish a session.
- Run only one application replica because sessions are stored in the running process.
- Treat files created from the terminal as disposable unless you configure persistent storage in Coolify.

To change the password, replace `AUTH_PASSWORD` in Coolify and redeploy the application.

## Run Locally

Install Node.js 24 and `ttyd`, then run:

```bash
npm ci
cp .env.example .env
```

Set `AUTH_PASSWORD` and a random `SESSION_SECRET` in `.env`, ensure `ttyd` is available at `http://127.0.0.1:7681`, then run:

```bash
npm start
```

Open `http://localhost:3000`. Use `NODE_ENV=development` and `TRUST_PROXY=false` when testing without HTTPS.

## Troubleshooting

- **Login returns to the sign-in page:** Confirm the deployment uses HTTPS and set `TRUST_PROXY=true`.
- **Terminal shows “backend unavailable”:** Check the deployment logs for the `ttyd` process and leave `TTYD_URL` at its default unless you intentionally run it elsewhere.
- **WebSocket connection fails:** Confirm the proxy allows WebSocket upgrades for the application domain.
- **Health check fails:** Verify the required environment variables are present and inspect the application logs.

## License

Private project. Not licensed for redistribution.
