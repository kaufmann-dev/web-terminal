# Private Browser Terminal

A private, password-protected terminal you can open in a web browser. One admin account signs in through a secure login page, then uses persistent named shells powered by `ttyd` and `tmux`.

> **Security warning:** A browser terminal can run shell commands in its deployment container. Protect it with HTTPS, strong credentials, and restricted network access. This Coolify setup does not provide a shell on the Coolify host.

## Coolify Deployment

### 1. Create the application

Connect this repository to a new Coolify application and use these settings:

- **Build Pack:** Nixpacks
- **Base Directory:** `/`

The included Nixpacks configuration installs `ttyd` and `tmux`, then starts `ttyd` privately alongside the web application. The deployment is not a static site and needs no pre- or post-deployment command.

### 2. Set the environment variables

Required:

- `AUTH_EMAIL` — the email address used to sign in.
- `AUTH_PASSWORD` — the long, unique password used to sign in; the app hashes it automatically at startup.
- `SESSION_SECRET` — a unique random string of at least 32 characters.

Optional:

- `NODE_ENV` — defaults to `production`.
- `TTYD_URL` — defaults to `http://127.0.0.1:7681`, which matches the bundled terminal process.
- `TERMINAL_WORKDIR` — defaults to `/code`; the terminal opens in this directory.

Coolify supplies `PORT` automatically; do not set a fixed port.

### 3. Add persistent storage

In Coolify's **Persistent Storage** settings, add a volume:

- **Name:** any descriptive name, such as `web-terminal-code`.
- **Source Path:** leave empty for a named volume.
- **Destination Path:** `/code`.

For a bind mount instead, use a persistent host path such as `/data/web-terminal-code` as the **Source Path** and `/code` as the **Destination Path**. If you choose another destination, set `TERMINAL_WORKDIR` to that exact absolute path.

### 4. Deploy and sign in

Deploy the application, open its Coolify domain, and sign in with `AUTH_EMAIL` and `AUTH_PASSWORD`.

Check `https://your-domain.example/health` if you want to confirm that the web application is responding.

## Everyday Use

- The first visit creates a session named `main`. Use the sidebar to create and switch between more named sessions.
- Closing the page, losing the connection, or clicking **Logout** detaches the browser. Commands, Codex jobs, and other processes keep running inside `tmux`.
- Deleting a terminal session is destructive: it stops every process running in that session.
- Terminal processes do not survive a Coolify redeploy or container restart. Files under persistent storage do survive.
- Run only one application replica because login state and terminal sessions are local to the running container.
- Store projects under `TERMINAL_WORKDIR`. They survive redeployments only when Coolify mounts persistent storage at that path.

To change the password, replace `AUTH_PASSWORD` in Coolify and redeploy the application.

## Run Locally

Install Node.js 24, `ttyd`, and `tmux`, then run:

```bash
npm ci
cp .env.example .env
```

Set `AUTH_PASSWORD`, a random `SESSION_SECRET`, and your preferred `TERMINAL_WORKDIR` in `.env`. Create that exact directory (the example uses the default `/code`), start the private `ttyd` service from the repository root, then run the app:

```bash
mkdir -p /code
ttyd --interface 127.0.0.1 --port 7681 --base-path /ttyd --writable --url-arg /bin/bash "$PWD/scripts/attach-terminal-session.sh" &
npm start
```

Open `http://localhost:3000`. Use `NODE_ENV=development` when testing without HTTPS.

## Troubleshooting

- **Login returns to the sign-in page:** Confirm the deployment uses HTTPS and redeploy the latest application version.
- **Terminal shows “backend unavailable”:** Check the deployment logs for the `ttyd` process and leave `TTYD_URL` at its default unless you intentionally run it elsewhere.
- **Sessions cannot be listed or created:** Confirm `tmux` is installed and available to both the Node and `ttyd` processes.
- **Terminal starts in the wrong directory:** Ensure `TERMINAL_WORKDIR` exactly matches the persistent-storage destination path.
- **Sessions disappeared after deployment:** This is expected when the container restarts; only files stored on a persistent volume survive redeployment.
- **WebSocket connection fails:** Confirm the proxy allows WebSocket upgrades for the application domain.
- **Health check fails:** Verify the required environment variables are present and inspect the application logs.

## License

Private project. Not licensed for redistribution.
