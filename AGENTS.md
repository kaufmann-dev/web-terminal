# Repository Instructions

## Build and Verification

- Use Node.js 24.x. Treat `package.json` `engines.node` as the runtime source of truth.
- Use npm and preserve `package-lock.json`. Install exact dependencies with:

```bash
npm ci
```

- The repository has no lint, test, type-check, or build script. After JavaScript changes, run the applicable syntax checks:

```bash
node --check app.js
node --check public/js/login.js
node --check public/js/terminal.js
```

- Use `npm start` only when a runtime check is necessary. The app exits unless `AUTH_EMAIL`, `AUTH_PASSWORD`, and `SESSION_SECRET` are set.

## Security and Architecture

- Keep `app.js` as the Express entrypoint for login, sessions, CSRF protection, rate limiting, static assets, health checks, and the `ttyd` proxy.
- Hash `AUTH_PASSWORD` once with Argon2id before opening the HTTP listener; never log the password or compare it directly during login.
- Preserve both authentication gates for `/ttyd`: normal HTTP requests pass through `ttydAuthGate`, while WebSocket upgrades are checked in the server `upgrade` handler.
- Keep `ttyd` private on loopback port `7681` with base path `/ttyd`. The iframe URL, proxy path, service command, and Nixpacks start command must remain aligned.
- Keep application-managed terminal sessions isolated on the `web-terminal` tmux socket. Session names must remain validated before they reach the attach-only ttyd wrapper, and browser disconnects or logout must not kill tmux sessions.
- Treat terminal-session deletion as the only UI operation that intentionally stops the processes in a session. Do not add raw tmux commands or arbitrary ttyd URL arguments.
- Keep Express configured for exactly one trusted proxy hop. Do not use unrestricted `trust proxy` because client-controlled forwarding headers could bypass IP-based rate limits.
- Never commit `.env` or real credentials. Keep variable names and defaults synchronized across `app.js`, `.env.example`, and the user-facing README.
- Sessions use a bounded, expiring in-process `memorystore`. Do not configure multiple application replicas without first replacing it with shared session storage.
- `views/` and `public/` are served directly; there is no frontend framework or asset build step.

## Deployment Configuration

- Keep runtime versions in the native `package.json` engine declaration. Do not duplicate the Node version in `nixpacks.toml`.
- `nixpacks.toml` installs the non-default `ttyd` and `tmux` packages and starts `ttyd` beside the Node process. Keep Express bound to the Coolify-provided `PORT` and keep `ttyd` inaccessible outside the container.
- The Nixpacks start command must create `TERMINAL_WORKDIR` idempotently. The Node session API passes it to tmux when creating sessions; its default is `/code` and must remain synchronized with `.env.example` and the README storage instructions.
- Document Coolify UI-only settings and operator environment variables in the managed `## Coolify Deployment` README section, not in `nixpacks.toml`.
- Treat `deploy/` as the manual VPS alternative. Update its systemd and Caddy examples whenever paths, ports, process commands, or the `/ttyd` base path change.
