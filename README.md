# Private Browser Terminal

A private, password-protected development terminal that runs in your browser. One admin account
uses persistent named shells powered by xterm.js and `node-pty`, with Node.js 24, AI coding tools,
GitHub tooling, a Chromium automation CLI, and a persistent workspace.

The browser connects to Express through an authenticated, same-origin WebSocket. Each named shell
is a process-local PTY whose output is also retained in a bounded headless xterm for reconnect
snapshots. Browser disconnects do not own or stop the shell.

> **Security warning:** This terminal can run arbitrary commands inside its application container.
> Protect it with HTTPS, strong credentials, and restricted network access. It does not provide a
> shell on the Coolify host.

## Coolify Deployment

### 1. Create the application

Connect this repository to a Coolify application with:

- **Build Pack:** Nixpacks
- **Base Directory:** `/`
- **Replicas:** `1`

The included Nixpacks configuration installs the development toolchain and the native build
dependencies for `node-pty`, then starts the combined web and PTY service. The deployment needs no
pre- or post-deployment command. Do not set `NIXPACKS_NODE_VERSION`; `package.json` selects Node.js
24.

### 2. Set environment variables

Required:

- `AUTH_EMAIL` — email address used to sign in.
- `AUTH_PASSWORD` — long, unique password used to sign in.
- `SESSION_SECRET` — unique random string of at least 32 characters.
- `PUBLIC_ORIGIN` — browser-facing HTTP(S) origin, for example
  `https://terminal.kaufmann.dev`. Include the scheme and any non-default port, with no path.

Optional:

- `NODE_ENV` — defaults to `production`.
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

Check `https://your-domain.example/health` to confirm the application is responding. The reverse
proxy must preserve WebSocket upgrades. `PUBLIC_ORIGIN` must exactly match the origin shown in the
browser address bar.

## Included Commands

The terminal includes:

- Node.js 24, npm, and npx
- `codex` 0.144.5 and `opencode` 1.18.3
- `agent-browser` 0.32.1 with Chromium
- `gh`, `git-wrangler` 0.12.0, Git, SSH, and `git-filter-repo`
- `chezmoi`, `micro`, `fzf`, `rg`, `fd`, `jq`, `yq`, and common archive/build tools
- focused process, network, and DNS diagnostics

The browser terminal PATH prioritizes the image's pinned commands and also includes
`~/.local/bin`, so user-level scripts stored on `/code` remain callable.

## First Use

The first container start initializes and applies
[`kaufmann-dev/dotfiles`](https://github.com/kaufmann-dev/dotfiles). Later starts pull and apply
updates. Startup applies the managed dotfiles state non-interactively, so a conflicting managed
file such as `~/.codex/config.toml` is replaced instead of blocking the container for input. If
GitHub is temporarily unavailable, the last local dotfiles state is applied instead.

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

- The first visit creates a session named `main`. Use the sidebar to create and switch between
  named sessions.
- Closing the page, losing the connection, refreshing, or clicking **Logout** detaches the browser.
  Commands, Codex jobs, and other processes keep running in the application-managed PTY.
- Reconnecting restores up to 10,000 retained scrollback lines plus the current screen. Output
  produced while disconnected appears in order before live output resumes.
- xterm.js handles wheel scrolling directly. There is no tmux copy mode, Codex-specific wheel
  routing, or synthetic keyboard input.
- A named session accepts one browser client. Opening it in a newer tab replaces the older tab
  without stopping the PTY.
- Deleting a terminal session is destructive: it sends SIGHUP to every process in the PTY's Linux
  session and escalates survivors to SIGKILL after two seconds.
- A naturally exited shell disappears from the sidebar and can be recreated under the same name.
- Terminal processes do not survive an application, container, or Coolify restart. Files under
  persistent storage do survive.
- Run only one application replica because login state and terminal sessions are process-local.
- Store repositories under `TERMINAL_WORKDIR`, for example `/code/projects/my-app`. They survive
  redeployments only when Coolify mounts persistent storage at that path.
- `cd ~` returns to `/code` with the default configuration.

To change the password, replace `AUTH_PASSWORD` in Coolify and redeploy the application.

## Run Locally

Install Node.js 24, chezmoi, and the compiler, make, Python, and pkg-config dependencies needed to
build `node-pty`, then run:

```bash
npm ci
cp .env.example .env
```

Set the required authentication values in `.env`, choose writable absolute terminal paths, export
the file's values, and start the same entrypoint used by Coolify:

```bash
set -a
source .env
set +a
bash scripts/start.sh
```

Open `http://localhost:3000`. Use `NODE_ENV=development` when testing locally without HTTPS. The
full bundled system toolset and Chromium are provided by the Nixpacks image, not by `npm ci`.

## Troubleshooting

- **Login returns to the sign-in page:** Confirm the deployment uses HTTPS and redeploy the latest
  application version.
- **Sessions cannot be created:** Check application logs for a `node-pty` spawn failure and confirm
  `TERMINAL_WORKDIR` and `TERMINAL_HOME` are absolute, writable directories.
- **Sessions disappeared after deployment:** This is expected when the application process or
  container restarts; only files stored on a persistent volume survive redeployment.
- **`codex: command not found`:** Redeploy the latest image and run `command -v codex`. Do not use
  the standalone installer; the bundled command comes from `/app/node_modules/.bin`.
- **Terminal starts in the wrong place:** Ensure `TERMINAL_WORKDIR` is an absolute path matching
  the persistent-volume destination.
- **`cd ~` opens the wrong directory:** Check `TERMINAL_HOME`; it defaults to `TERMINAL_WORKDIR`.
- **Dotfiles fail on first startup:** Confirm the container can reach GitHub. Later update failures
  fall back to the existing local checkout.
- **Terminal stays on “Connecting” or repeatedly reconnects:** Confirm the reverse proxy preserves
  WebSocket upgrades and `PUBLIC_ORIGIN` exactly matches the browser-facing scheme, host, and
  non-default port. Do not include a path.
- **Native dependency installation fails locally:** Install a C/C++ compiler, make, Python, and
  pkg-config, then rerun `npm ci` under Node.js 24.
- **Health check fails:** Verify all required environment variables are set, including
  `PUBLIC_ORIGIN`.

## License

Private project. Not licensed for redistribution.
