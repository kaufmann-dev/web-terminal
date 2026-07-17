# Repository Instructions

## Build and Verification

- Use Node.js 24.x. Treat `package.json` `engines.node` as the runtime source of truth.
- Use npm and preserve `package-lock.json`. Install exact dependencies with:

```bash
npm ci
```

- Keep these terminal CLIs as exact production dependencies so Nixpacks installs them into the
  immutable image: `@openai/codex@0.144.5`, `opencode-ai@1.18.3`, and
  `agent-browser@0.32.1`. Do not replace them with runtime installers or global npm installs.

- The repository has no lint, test, type-check, or build script. After JavaScript changes, run the applicable syntax checks:

```bash
node --check app.js
node --check public/js/login.js
node --check public/js/terminal.js
```

- Use `npm start` only when a runtime check is necessary. The app exits unless `AUTH_EMAIL`, `AUTH_PASSWORD`, and `SESSION_SECRET` are set.
- After shell-script changes, run `bash -n` on every file under `scripts/`.

## Security and Architecture

- Keep `app.js` as the Express entrypoint for login, sessions, CSRF protection, rate limiting, static assets, health checks, and the `ttyd` proxy.
- Hash `AUTH_PASSWORD` once with Argon2id before opening the HTTP listener; never log the password or compare it directly during login.
- Preserve both authentication gates for `/ttyd`: normal HTTP requests pass through `ttydAuthGate`, while WebSocket upgrades are checked in the server `upgrade` handler.
- Keep `ttyd` private on loopback port `7681` with base path `/ttyd`. The iframe URL, proxy path, service command, and Nixpacks start command must remain aligned.
- Keep Express configured for exactly one trusted proxy hop. Do not use unrestricted `trust proxy` because client-controlled forwarding headers could bypass IP-based rate limits.
- Never commit `.env` or real credentials. Keep variable names and defaults synchronized across `app.js`, `.env.example`, and the user-facing README.
- Keep `AUTH_EMAIL`, `AUTH_PASSWORD`, and `SESSION_SECRET` out of the terminal, ttyd, and chezmoi
  environments. Express must retain them.
- Sessions use a bounded, expiring in-process `memorystore`. Do not configure multiple application replicas without first replacing it with shared session storage.
- `views/` and `public/` are served directly; there is no frontend framework or asset build step.

## Deployment Configuration

- Keep runtime versions in the native `package.json` engine declaration. Do not duplicate the Node version in `nixpacks.toml`.
- `nixpacks.toml` owns the immutable system package list and invokes the Git Wrangler build script.
  Keep Node's version in `package.json`; do not add `NIXPACKS_NODE_VERSION` or a second Node pin.
- Keep Git Wrangler pinned to v0.12.0. Its build script must support Linux AMD64 and ARM64,
  verify the official checksum manifest, install the bundled Bash completion, and fail on unknown
  architectures or ambiguous checksums.
- Nixpacks installs Chromium for `agent-browser`; do not use agent-browser's runtime browser
  installer. Keep `AGENT_BROWSER_CONTENT_BOUNDARIES=1` in the terminal environment.
- `scripts/start.sh` supervises Express and ttyd. It must forward shutdown to both processes and
  stop the container if either process exits.
- Keep ttyd private on loopback. Its terminal environment sets `HOME`, XDG directories, and PATH;
  the Express process keeps the container's original HOME.
- Keep `TERMINAL_WORKDIR` defaulted to `/code` and `TERMINAL_HOME` defaulted to the effective work
  directory. Both must be absolute, and directory creation must remain idempotent.
- The terminal PATH must prioritize `/app/node_modules/.bin`, include `$TERMINAL_HOME/.local/bin`,
  and preserve the image PATH so pinned CLIs, user scripts, and Nix packages are callable.
- On first startup, initialize and apply `https://github.com/kaufmann-dev/dotfiles.git`. On later
  starts, update it; if the remote update fails, apply the existing local source. Do not continue
  after first-time initialization or local apply failures.
- Document Coolify UI-only settings and operator environment variables in the managed `## Coolify Deployment` README section, not in `nixpacks.toml`.
- Validate the Nixpacks plan and generate its build context with `nixpacks build --out`; build and
  run that context with Podman, never Docker.
- Keep the dotfiles repository aligned with the browser and MCP defaults. The web terminal uses
  agent-browser and GitHub's remote MCP; Massive remains an optional credential-gated dotfiles
  integration and is not installed in this image.
- Treat `deploy/` as the manual VPS alternative. Update its systemd and Caddy examples whenever paths, ports, process commands, or the `/ttyd` base path change.
