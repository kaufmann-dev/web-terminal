# Private Browser Terminal

A private, password-protected development terminal that runs in your browser. One admin account
uses persistent named shells powered by `ttyd` and `tmux`, with Node.js 24, AI coding tools,
GitHub tooling, a Chromium automation CLI, and a persistent workspace.

> **Security warning:** This terminal can run arbitrary commands inside its application container.
> Protect it with HTTPS, strong credentials, and restricted network access. It does not provide a
> shell on the Coolify host.

## Coolify Deployment

### 1. Create the application

Connect this repository to a Coolify application with:

- **Build Pack:** Nixpacks
- **Base Directory:** `/`
- **Replicas:** `1`

The included Nixpacks configuration installs the development toolchain, `ttyd`, and `tmux`, then
starts the private terminal service alongside the web application. The deployment needs no pre-
or post-deployment command. Do not set `NIXPACKS_NODE_VERSION`; `package.json` selects Node.js 24.

### 2. Set environment variables

Required:

- `AUTH_EMAIL` — email address used to sign in.
- `AUTH_PASSWORD` — long, unique password used to sign in.
- `SESSION_SECRET` — unique random string of at least 32 characters.

Optional:

- `NODE_ENV` — defaults to `production`.
- `TTYD_URL` — defaults to `http://127.0.0.1:7681`.
- `TERMINAL_WORKDIR` — defaults to `/code`, where new terminal sessions start.
- `TERMINAL_HOME` — defaults to `TERMINAL_WORKDIR`; controls `~` and persisted tool state.

Coolify supplies `PORT` automatically. Do not set a fixed application port.

### 3. Mount persistent storage

Add one Coolify persistent volume:

- **Name:** any descriptive name, such as `web-terminal-code`.
- **Source Path:** leave empty for a named volume.
- **Destination Path:** `/code`.

With the default settings, `/code` is both the workspace and terminal home. Projects, dotfiles,
Git and SSH configuration, `gh` login, Codex/OpenCode state, chezmoi state, and optional
agent-browser profiles survive redeploys in this volume.

If you use different terminal paths, mount persistent storage over all of them and set
`TERMINAL_WORKDIR` and `TERMINAL_HOME` to absolute paths.

### 4. Deploy

Deploy, open the assigned domain, and sign in with `AUTH_EMAIL` and `AUTH_PASSWORD`. The image
build installs all included programs again on every deployment; credentials and personal state
remain on `/code`.

Check `https://your-domain.example/health` to confirm the web application is responding.

## Included Commands

The terminal includes:

- Node.js 24, npm, and npx
- `codex` 0.144.5 and `opencode` 1.18.3
- `agent-browser` 0.32.1 with Chromium
- `gh`, `git-wrangler` 0.12.0, Git, SSH, and `git-filter-repo`
- `chezmoi`, `micro`, `tmux`, `fzf`, `rg`, `fd`, `jq`, `yq`, and common archive/build tools
- focused process, network, and DNS diagnostics

The browser terminal PATH prioritizes the image's pinned commands and also includes
`~/.local/bin`, so user-level scripts stored on `/code` remain callable.

## First Use

The first container start initializes and applies
[`kaufmann-dev/dotfiles`](https://github.com/kaufmann-dev/dotfiles). Later starts pull and apply
updates. If GitHub is temporarily unavailable, the last local dotfiles state is applied instead.

Authenticate the tools you use:

```bash
gh auth login
codex login
opencode auth login
git-wrangler init
```

These logins persist below `/code` with the default volume. Git Wrangler Bash completion is
available automatically. Agent-browser runs headlessly by default; use its persistent profile or
state options only when a task needs browser login state to survive.

Do not reinstall Codex or OpenCode with a runtime installer. Their exact versions are already in
the deployment image and available immediately as `codex` and `opencode`.

## Everyday Use

- The first visit creates a session named `main`. Use the sidebar to create and switch between more named sessions.
- Closing the page, losing the connection, or clicking **Logout** detaches the browser. Commands, Codex jobs, and other processes keep running inside `tmux`.
- Deleting a terminal session is destructive: it stops every process running in that session.
- Terminal processes do not survive a Coolify redeploy or container restart. Files under persistent storage do survive.
- Run only one application replica because login state and terminal sessions are local to the running container.
- Store repositories under `TERMINAL_WORKDIR`, for example `/code/projects/my-app`. They survive redeployments only when Coolify mounts persistent storage at that path.
- `cd ~` returns to `/code` with the default configuration.
- Use `micro`, `$EDITOR`, or an AI CLI to edit files.

To change the password, replace `AUTH_PASSWORD` in Coolify and redeploy the application.

## Run Locally

Install Node.js 24, `ttyd`, `tmux`, and chezmoi, then run:

```bash
npm ci
cp .env.example .env
```

Set the required authentication values in `.env`, choose writable local terminal paths, export the
file's values, and start the same supervisor used by Coolify:

```bash
set -a
source .env
set +a
bash scripts/start.sh
```

Open `http://localhost:3000`. Use `NODE_ENV=development` when testing locally without HTTPS. The
full bundled system toolset and Chromium are provided by the Nixpacks image, not by `npm ci`.

## Troubleshooting

- **Login returns to the sign-in page:** Confirm the deployment uses HTTPS and redeploy the latest application version.
- **Sessions cannot be listed or created:** Confirm `tmux` is installed and available to both the Node and `ttyd` processes.
- **Sessions disappeared after deployment:** This is expected when the container restarts; only files stored on a persistent volume survive redeployment.
- **`codex: command not found`:** Redeploy the latest image and run `command -v codex`. Do not use
  the standalone installer; the bundled command comes from `/app/node_modules/.bin`.
- **Terminal starts in the wrong place:** Ensure `TERMINAL_WORKDIR` is an absolute path matching
  the persistent-volume destination.
- **`cd ~` opens the wrong directory:** Check `TERMINAL_HOME`; it defaults to `TERMINAL_WORKDIR`.
- **Dotfiles fail on first startup:** Confirm the container can reach GitHub. Later update failures
  fall back to the existing local checkout.
- **Terminal shows “backend unavailable”:** Inspect deployment logs and keep `TTYD_URL` at its
  default unless ttyd is intentionally hosted elsewhere.
- **WebSocket connection fails:** Confirm the application proxy allows WebSocket upgrades.
- **Health check fails:** Verify all required authentication variables are set.

## License

Private project. Not licensed for redistribution.
