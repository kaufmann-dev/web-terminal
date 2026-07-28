# Private Browser Terminal

A private, OIDC-protected development terminal that runs in your browser. A provider-authorized
operator uses persistent named shells powered by xterm.js and `node-pty`, with Node.js 24, AI coding
tools, GitHub tooling, a Chromium automation CLI, and a persistent workspace.

The browser connects to Express through an authenticated, same-origin WebSocket. Each named shell
is a process-local PTY whose output is also retained in a bounded headless xterm for reconnect
snapshots. Browser disconnects do not own or stop the shell.

> **Security warning:** This terminal can run arbitrary commands inside its application container.
> Protect it with HTTPS, a securely configured identity provider, and restricted network access.
> Nested rootless Podman requires relaxed seccomp, AppArmor, and system-path policies plus access
> to `/dev/fuse` and `/dev/net/tun`.
> It uses a single host UID and does not provide a shell or container socket on the Coolify host.

## Authentication Setup

The terminal uses OIDC Authorization Code with PKCE for interactive login; provider policy is
the sole admission control.
After a successful callback, it creates a bounded server-side session and keeps only the ID
token for logout.

- Public Client: Off
- Callback URL: `/auth/callback`
- Logout Callback URL: `/`

Authentication variables are required and documented under
[Set environment variables](#2-set-environment-variables).

## Coolify Deployment

### 1. Create the application

Connect this repository to a Coolify application with:

- **Build Pack:** Nixpacks
- **Base Directory:** `/`
- **Replicas:** `1`
- **Custom Docker Options:**
  `--device /dev/fuse --device /dev/net/tun --security-opt seccomp=unconfined --security-opt apparmor=unconfined --security-opt systempaths=unconfined`

The included Nixpacks configuration installs the development toolchain and the native build
dependencies for `node-pty`, establishes the fixed non-root terminal identity, and configures nested
rootless Podman in single-UID mode. The deployment needs no pre- or post-deployment command. The
Coolify builder must use Nixpacks 1.41.0 or newer so the native `package.json` declaration resolves
Node.js 24; do not set `NIXPACKS_NODE_VERSION`.

Before deploying, prepare the Coolify host:

```bash
sudo modprobe fuse
sudo modprobe tun
test -c /dev/fuse
test -c /dev/net/tun
```

Persist the `fuse` and `tun` modules through the host's module-loading configuration if either is
not loaded after reboots. Do not replace the listed Custom Docker Options with `--privileged`, add
`SYS_ADMIN`, or mount the host Docker or Podman socket into this application.

### 2. Set environment variables

Required:

- `OIDC_ISSUER_URL` — exact, non-secret discovery issuer URL.
- `OIDC_CLIENT_ID` — non-secret confidential-client identifier.
- `OIDC_CLIENT_SECRET` — confidential-client secret.
- `SESSION_SECRET` — unique random string of at least 32 characters.
- `PUBLIC_ORIGIN` — browser-facing HTTP(S) origin, for example
  `https://terminal.kaufmann.dev`. Include the scheme and any non-default port, with no path.

Optional:

- `NODE_ENV` — defaults to `production`.
- `TERMINAL_WORKDIR` — defaults to `/code`, where new terminal sessions start.
- `TERMINAL_HOME` — defaults to `TERMINAL_WORKDIR`; controls `~` and persisted tool state.

Coolify supplies `PORT` automatically. Do not set a fixed application port.
If you override it outside Coolify, use port 1024 or higher because the application runs as a
non-root user.

Keep `OIDC_CLIENT_SECRET` and `SESSION_SECRET` secret. Copy the generated client ID, client secret,
and exact discovery issuer into the corresponding variables without exposing their values. Remove
`OIDC_ALLOWED_SUBJECT` from existing deployments; it is no longer supported.

### 3. Mount persistent storage

Add one Coolify persistent volume:

- **Name:** any descriptive name, such as `web-terminal-code`.
- **Source Path:** leave empty for a named volume.
- **Destination Path:** `/code`.

With the default settings, `/code` is both the workspace and terminal home. Projects, dotfiles,
Git and SSH configuration, `gh` login, Codex/OpenCode state, chezmoi state, and optional
agent-browser profiles survive redeploys in this volume. Rootless Podman images, volumes, and
registry credentials are also stored there.

If you use different terminal paths, mount persistent storage over all of them and set
`TERMINAL_WORKDIR` and `TERMINAL_HOME` to absolute paths.

On the first deployment of this version, startup recursively changes the configured terminal paths
to UID/GID 1000 and writes a migration marker. Later starts do not repeat that ownership walk.

### 4. Deploy

Deploy, open the assigned domain, and follow the OIDC sign-in link. The image build installs all
included programs again on every deployment; tool credentials and personal state remain on
`/code`.

Check `https://your-domain.example/health` to confirm the application is responding. The reverse
proxy must preserve WebSocket upgrades. `PUBLIC_ORIGIN` must exactly match the origin shown in the
browser address bar. Startup deliberately fails before listening if `/dev/fuse`, `/dev/net/tun`,
user namespaces, or the rootless Podman configuration is unavailable.

## Included Commands

The terminal includes:

- Node.js 24, npm, npx, and pnpm 11.17.0
- Vitest 4.1.10
- `codex` 0.145.0 and `opencode` 1.18.3
- `agent-browser` 0.32.1 with headless Chromium and its Nix Fontconfig environment
- `xvfb-run` for virtual X displays and `xdotool` for X11 input/window automation, backed by the
  matching Nix X11, Vulkan, and Mesa runtime needed by GUI programs built in the terminal
- rootless Podman for image builds and ordinary container runs
- Nixpacks 1.41.0 for plan/build-context inspection and uv for Python projects
- `gh`, `git-wrangler` 0.12.0, Git, SSH, and `git-filter-repo`
- `chezmoi`, `micro`, `fzf`, `rg`, `fd`, `jq`, `yq`, and common archive/build tools
- focused process, network, and DNS diagnostics

The browser terminal PATH starts with `/app/node_modules/.bin` and `~/.local/bin`, explicitly
includes `/usr/local/bin` for Git Wrangler, and then preserves the Nixpacks image PATH. Pinned npm
commands, user scripts stored on `/code`, Git Wrangler, and Nix packages are all callable.

Nixpacks can validate a deployment plan and emit its OCI build context, and the bundled Podman can
build and run that context directly. Podman uses `fuse-overlayfs`, persistent storage below
`TERMINAL_HOME`, Buildah chroot isolation, and a single UID mapping. Files owned by different users
inside a nested image are stored as UID 1000 outside its user namespace. This avoids `SYS_ADMIN`
and subordinate-ID mappings, but images that require distinct persisted owners may not work.
Inner cgroups are disabled because Coolify does not delegate a writable cgroup tree, so nested
`--memory`, `--cpus`, cgroup-parent options, privileged containers, and host port mappings below
1024 are unsupported.

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
available automatically. Agent-browser runs headlessly by default, and every managed terminal
receives the Nix-provided Fontconfig configuration automatically, so ordinary unprefixed
`agent-browser open`, `snapshot`, and `close` commands work. Use persistent profile or state
options only when a task needs browser login state to survive.

Do not reinstall Codex or OpenCode with a runtime installer. Their exact versions are already in
the deployment image and available immediately as `codex` and `opencode`.

## Everyday Use

- The first visit creates a session named `main`. Use the sidebar to create and switch between
  named sessions.
- The application and every terminal session run as the fixed non-root UID/GID 1000. Use rootless
  Podman for container builds; `sudo` and host-level container access are intentionally absent.
- Closing the page, losing the connection, refreshing, or clicking **Logout** detaches the browser.
  Commands, Codex jobs, and other processes keep running in the application-managed PTY.
- Login sessions expire after 24 hours without accepted interactive activity and always expire
  seven days after the original OIDC login. Terminal-page navigation, session creation/deletion,
  clipboard-image uploads, and accepted terminal input or paste extend the idle deadline. Polling,
  CSRF retrieval, WebSocket reconnect/resize/heartbeat traffic, PTY output, static assets, health
  checks, pushed updates, and merely leaving a tab open do not.
- **Logout** destroys the local session and its retained ID token before navigating to the
  provider's RP-Initiated Logout endpoint. It may end provider-wide SSO when that is the provider's
  policy. Idle or absolute expiry destroys only the local session; the next access starts a new
  OIDC authorization flow.
- Reconnecting restores up to 10,000 retained scrollback lines plus the current screen. Hidden
  pages detach from live output so returning to the page restores the latest snapshot instead of
  replaying backgrounded terminal frames. Regaining browser connectivity immediately retries any
  pending reconnect backoff.
- xterm.js handles wheel scrolling directly. Its compact line height keeps adjacent rows of block
  glyphs continuous. There is no tmux copy mode, Codex-specific wheel routing, or synthetic
  keyboard input.
- Selecting terminal text copies it to the browser clipboard automatically and displays a brief
  confirmation. Use `Ctrl+V` to paste text or an image; `Ctrl+Shift+V` remains text-only. Pasting
  a PNG, JPEG, or WebP image up to 10 MiB uploads it to
  `$TERMINAL_HOME/.cache/web-terminal/clipboard-images` and inserts its absolute path into the
  terminal; images older than 24 hours are pruned at startup and on later image uploads. Because
  `Ctrl+V` is reserved for browser paste, it is not sent to the terminal as the `^V` control
  character.
- Keyboard characters follow the active layout on the browser device. Spawned shells use a UTF-8
  locale so international characters such as `ß` work for typed and pasted input.
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

To switch identity providers, create an equivalent standard client registration and replace the
three `OIDC_*` variables. No application code or terminal-data migration is required.

## Run Locally

Install Node.js 24, chezmoi, and the compiler, make, Python, and pkg-config dependencies needed to
build `node-pty`, then run:

```bash
npm ci
cp .env.example .env
```

Register `http://localhost:3000/auth/callback` and `http://localhost:3000/` with a development OIDC
client. Set its three `OIDC_*` values in `.env`, choose writable absolute terminal paths, export the
file's values, and start the same entrypoint used by Coolify:

```bash
set -a
source .env
set +a
bash scripts/start.sh
```

Open `http://localhost:3000`. Use `NODE_ENV=development` when testing locally without HTTPS. The
full bundled system toolset and Chromium are provided by the Nixpacks image, not by `npm ci`.

## Troubleshooting

- **Application exits before listening:** Confirm the issuer discovery document is reachable and
  publishes authorization, token, and RP-Initiated Logout endpoints. A provider without
  `end_session_endpoint` is incompatible.
- **OIDC callback is rejected:** Confirm the registered Authorization redirect is exactly
  `<PUBLIC_ORIGIN>/auth/callback`, the client is confidential, Authorization Code and PKCE S256 are
  enabled, and the application requests only `openid`.
- **An unexpected identity can sign in:** Restrict the OIDC application's access policy to the
  intended user, administrator group, or equivalent provider-managed rule.
- **The provider denies the intended identity:** Review the OIDC application's access policy and
  the provider's policy evaluation result.
- **Provider logout is rejected:** Register `<PUBLIC_ORIGIN>/` as the post-logout redirect URI.
- **Sessions cannot be created:** Check application logs for a `node-pty` spawn failure and confirm
  `TERMINAL_WORKDIR` and `TERMINAL_HOME` are absolute, writable directories.
- **Sessions disappeared after deployment:** This is expected when the application process or
  container restarts; only files stored on a persistent volume survive redeployment.
- **`codex: command not found`:** Redeploy the latest image and run `command -v codex`. Do not use
  the standalone installer; the bundled command comes from `/app/node_modules/.bin`.
- **Agent-browser reports a Fontconfig error or loses Chromium:** Redeploy the latest image and
  verify `FONTCONFIG_FILE` and `FONTCONFIG_PATH` point below `/root/.nix-profile/etc/fonts`. Do not
  run agent-browser's browser installer or prefix individual commands with store paths.
- **A locally built GUI cannot load X11 or Vulkan libraries:** Redeploy the latest image and verify
  `LD_LIBRARY_PATH` contains Nix store library directories while `XDG_DATA_DIRS` and
  `LIBGL_DRIVERS_PATH` point below `/root/.nix-profile`. Do not force an Ubuntu dynamic loader into
  an executable produced by the Nix compiler.
- **Terminal starts in the wrong place:** Ensure `TERMINAL_WORKDIR` is an absolute path matching
  the persistent-volume destination.
- **`cd ~` opens the wrong directory:** Check `TERMINAL_HOME`; it defaults to `TERMINAL_WORKDIR`.
- **Dotfiles fail on first startup:** Confirm the container can reach GitHub. Later update failures
  fall back to the existing local checkout.
- **Startup reports that `/dev/fuse` is unavailable:** Load the host `fuse` module, confirm
  `/dev/fuse` exists, and copy the documented Custom Docker Options into Coolify exactly.
- **Startup reports that `/dev/net/tun` is unavailable:** Load the host `tun` module, confirm
  `/dev/net/tun` exists, and copy the documented Custom Docker Options into Coolify exactly.
- **Startup reports that user namespaces are blocked:** Confirm both `seccomp=unconfined` and
  `apparmor=unconfined` are present in Coolify's Custom Docker Options, then redeploy.
- **Startup reports that nested proc mounts are blocked:** Add
  `--security-opt systempaths=unconfined` to Coolify's Custom Docker Options, then redeploy.
- **Podman warns that no subordinate UID or GID ranges are configured:** This deployment
  intentionally uses a single UID mapping so it can remain rootless without `SYS_ADMIN`. Different
  owners inside nested images are flattened to UID/GID 1000 in persistent Podman storage.
- **Podman rejects CPU, memory, or cgroup flags:** Nested cgroups are intentionally disabled.
  Run the container without those flags or use a separate container host when resource delegation
  is required.
- **Podman storage consumes too much space:** Inspect it with `podman system df` and remove unused
  data with `podman system prune`; Podman storage persists below `TERMINAL_HOME`.
- **Build logs select `nodejs_18`:** Update Coolify to a release that uses Nixpacks 1.41.0 or
  newer. Nixpacks 1.40 does not recognize Node.js 24 and must not build this application.
- **Terminal stays on “Connecting” or repeatedly reconnects:** Confirm the reverse proxy preserves
  WebSocket upgrades and `PUBLIC_ORIGIN` exactly matches the browser-facing scheme, host, and
  non-default port. Do not include a path.
- **Native dependency installation fails locally:** Install a C/C++ compiler, make, Python, and
  pkg-config, then rerun `npm ci` under Node.js 24.
- **Health check fails:** Verify all required `OIDC_*`, `SESSION_SECRET`, and `PUBLIC_ORIGIN`
  variables are set and discovery succeeds.
