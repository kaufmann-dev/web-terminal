# Repository Instructions

## Build and Verification

- Use Node.js 24.x. Treat `package.json` `engines.node` as the runtime source of truth.
- Use npm and preserve `package-lock.json`. Install exact dependencies with:

```bash
npm ci
```

- Keep these terminal CLIs as exact production dependencies so `npm ci` installs them into the
  immutable image: `@openai/codex@0.146.0`, `opencode-ai@1.18.9`,
  `agent-browser@0.33.1`, `pnpm@11.18.0`, and `vitest@4.1.10`. Do not replace them with runtime
  installers or global npm installs. Exact dependency locks make an individual image reproducible;
  they are not promises to retain old releases. Advance them, their lockfile entries, and the
  documented versions when newer compatible stable releases are available.
- Keep `allowScripts` limited to version-pinned approvals for `agent-browser`, `node-pty`, and
  `opencode-ai`. Their installation scripts provide required native executables; update each
  approval with its dependency version instead of allowing all dependency scripts.

- The repository has no lint, type-check, or build script. After JavaScript changes, run the
  applicable syntax checks and targeted Node tests:

```bash
node --check app.js
node --check terminal-session-manager.js
node --check public/js/terminal.js
node --test test/*.test.js
```

- Use `npm start` only when a runtime check is necessary. The app exits unless the three `OIDC_*`
  variables, `SESSION_SECRET`, and `PUBLIC_ORIGIN` are set and discovery succeeds.
- After shell-script changes, run `bash -n` on every file under `scripts/`.

## Security and Architecture

- Keep `app.js` as the Express entrypoint for OIDC login, local sessions, CSRF protection,
  static assets, health checks, and authenticated terminal WebSockets.
- Use `openid-client` 6.8.4 discovery and Authorization Code with PKCE S256, state, and nonce.
  Require authorization, token, and RP-Initiated Logout endpoints before listening, request only
  `openid`, and use the OIDC provider's application access policy as the sole admission control.
  Do not add application-level identity or claim allowlists.
- Keep OIDC tokens out of authorization after callback. Discard access and refresh tokens, retain
  the ID token only for `id_token_hint`, and regenerate a bounded local application session.
- Enforce the 24-hour interactive idle and seven-day absolute local-session deadlines on protected
  HTTP, WebSocket upgrade, and heartbeat paths. Passive traffic must not extend either deadline.
- Keep terminal WebSockets in `ws` no-server mode at `/ws/terminal`. Authenticate upgrades with
  the Express session middleware, require `Origin` to exactly match the normalized
  `PUBLIC_ORIGIN`, validate session names, and never create a session during an upgrade. Do not
  infer the public origin from reverse-proxy headers.
- Keep application-managed terminal sessions process-local in `terminal-session-manager.js`. Each
  named session owns one `node-pty` Bash process, a headless xterm with 10,000 lines of scrollback,
  an ordered state/output queue, and at most one attached browser client.
- Feed PTY output through headless xterm before sending it. Reconnect snapshots must serialize
  retained normal scrollback and the active/alternate screen before live output resumes.
- Browser disconnects, refresh, session switching, and logout must detach clients without stopping
  PTYs. A newer client replaces the older client for the same named session.
- Treat terminal-session deletion as the only UI operation that intentionally stops processes.
  Signal every process in the PTY's Linux session with SIGHUP, then SIGKILL survivors after two
  seconds. Natural shell exit removes the session.
- Keep Express configured for exactly one trusted proxy hop. Do not use unrestricted `trust proxy`.
- Never commit `.env` or real credentials. Keep variable names and defaults synchronized across `app.js`, `.env.example`, and the user-facing README.
- Keep all `OIDC_*` variables and `SESSION_SECRET` out of terminal and chezmoi environments.
  Express must retain them.
- Login sessions use a bounded, expiring in-process `memorystore`, and PTY sessions are also
  process-local. Do not configure multiple application replicas without replacing both designs.
- Serve only the pinned xterm browser module, fit addon, stylesheet, and self-hosted font files
  through explicit same-origin vendor routes. Use xterm's DOM renderer with a line height of `1`
  so adjacent block-character rows remain continuous. Do not copy package artifacts into the
  repository or add a bundler.
- `views/` and `public/` are served directly; there is no frontend framework or asset build step.

## Deployment Configuration

- The production image is built by the repository `Dockerfile` from CentOS Stream 10. Coolify uses
  its Dockerfile build pack with `/Dockerfile`; do not add a Nixpacks deployment plan.
- CentOS Stream 10's x86_64 image requires an x86-64-v3 host CPU. Keep that operator constraint in
  the Coolify README whenever the base remains CentOS Stream 10.
- Keep runtime versions in the native `package.json` engine declaration. Node.js 24 remains the
  current LTS line and is installed from CentOS/EPEL's maintained `nodejs24` stream. Do not preserve
  Node 24 after it ceases to be the appropriate maintained line; update the engine, image package,
  tests, and documentation together.
- The floating CentOS Stream 10 base and `dnf update` intentionally take current distribution
  updates on each image rebuild. Install system tools, Chromium, Fontconfig, Mesa, uv, Podman, and
  build dependencies natively with DNF; do not add a Nix runtime or Nix store paths.
- Git Wrangler v0.12.0, Nixpacks v1.41.0, and xdotool v4.20260303.1 are the current
  checksum-verified artifact releases. Their installers must support the documented architectures,
  reject unknown artifacts, and be advanced when newer compatible stable releases exist. Nixpacks
  is a bundled terminal command for working on other projects, not this application's build pack
  or system package manager.
- Chromium and the native `/etc/fonts` configuration support `agent-browser`; do not use
  agent-browser's runtime browser installer. Keep `FONTCONFIG_FILE`, `FONTCONFIG_PATH`, and
  `AGENT_BROWSER_CONTENT_BOUNDARIES=1` in the terminal environment.
- CentOS Stream 10 has no Xvfb package. Keep `xwfb-run` from `xwayland-run` configured with the Cage
  headless Wayland compositor, and build the current checksum-verified xdotool release. xdotool
  controls X11 clients in that dedicated Xwayland session; it does not control unrelated native
  Wayland clients.
- Install Podman 6 or newer, Netavark, Aardvark DNS, Pasta, rootlessport, conmon, crun, and
  fuse-overlayfs from the maintained CentOS Stream 10/EPEL repositories. Pasta provides the outer
  rootless network namespace while Netavark/Aardvark provide bridge networking and DNS, including
  Docker-compatible explicit `bridge` requests. Do not install `slirp4netns`.
- Override CentOS's automatic RHEL subscription mounts with the managed empty
  `/etc/containers/mounts.conf`. Those implicit `/run/secrets` mounts do not belong in this
  development terminal and fail with single-UID storage; explicit Podman secrets remain supported.
- Keep the compiler, make, Python, and pkg-config system packages required to build `node-pty`.
  Do not add ttyd or tmux back to the image.
- `scripts/start.sh` validates and creates terminal paths, performs the one-time UID/GID 1000
  ownership migration, performs the one-time clean Podman 6 storage initialization, validates
  nested rootless Podman, applies chezmoi as the terminal user, and then drops to that user before
  replacing itself with `node app.js`. The storage initializer intentionally removes legacy
  containers, images, volumes, runtime data, and custom networks while preserving registry
  credentials and unrelated terminal data. It must validate every deletion target, retry after an
  interruption, and never reset state again after writing its completion marker. The Node shutdown
  path must close WebSockets and terminate all child PTYs.
- The PTY environment sets `HOME`, XDG directories, PATH, `TERM=xterm-256color`, and
  `COLORTERM=truecolor`; the Express process keeps the container's original HOME while running as
  UID/GID 1000.
- Keep `TERMINAL_WORKDIR` defaulted to `/code` and `TERMINAL_HOME` defaulted to the effective work
  directory. Both must be absolute, directory creation must remain idempotent, and new PTY
  sessions must start in `TERMINAL_WORKDIR` with the managed terminal Bash configuration.
- The terminal PATH must prioritize `/app/node_modules/.bin`, include `$TERMINAL_HOME/.local/bin`
  and `/usr/local/bin`, and preserve the image PATH so pinned CLIs, user scripts, locally installed
  image commands, and native distribution packages are callable.
- Keep nested Podman rootless in single-UID mode, with no subordinate UID/GID ranges and
  `ignore_chown_errors` enabled for fuse-overlayfs storage under `TERMINAL_HOME`. Keep Buildah
  chroot isolation, file events, and inner cgroups disabled. Keep the SQLite database, Netavark
  network backend, Pasta rootless command, and rootlessport bridge port forwarder explicit. Never
  add `--privileged`, `SYS_ADMIN`, or a host Docker/Podman socket. Coolify must pass `/dev/fuse` and
  `/dev/net/tun`, and use unconfined seccomp, AppArmor, and system paths through Custom Docker
  Options.
- On first startup, initialize and apply `https://github.com/kaufmann-dev/dotfiles.git`. On later
  starts, update it; if the remote update fails, apply the existing local source. Do not continue
  after first-time initialization or local apply failures.
- Document Coolify UI-only settings and operator environment variables in the managed
  `## Coolify Deployment` README section, not in image build files.
- Build and test the repository Dockerfile with Podman, never Docker. Before starting a local
  project container, follow the repository's instance-enumeration rule. Building this system image
  requires rootful Podman or a rootless host with subordinate IDs because RPM payloads contain
  multiple owners; do not weaken the production image to make it self-build in the deployed
  single-ID terminal.
- Keep the dotfiles repository aligned with the browser and MCP defaults. The web terminal uses
  agent-browser and GitHub's remote MCP; Massive remains an optional credential-gated dotfiles
  integration and is not installed in this image.
- Treat `deploy/` as the manual VPS alternative. Update its systemd and Caddy examples whenever
  paths, ports, process commands, or WebSocket routing change.
