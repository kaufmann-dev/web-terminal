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
node --check scripts/hash-password.js
node --check public/js/login.js
node --check public/js/terminal.js
```

- Use `npm start` only when a runtime check is necessary. The app exits unless `AUTH_EMAIL`, `AUTH_PASSWORD_HASH`, and `SESSION_SECRET` are set.

## Security and Architecture

- Keep `app.js` as the Express entrypoint for login, sessions, CSRF protection, rate limiting, static assets, health checks, and the `ttyd` proxy.
- Preserve both authentication gates for `/ttyd`: normal HTTP requests pass through `ttydAuthGate`, while WebSocket upgrades are checked in the server `upgrade` handler.
- Keep `ttyd` private on loopback port `7681` with base path `/ttyd`. The iframe URL, proxy path, service command, and Nixpacks start command must remain aligned.
- Never commit `.env` or real credentials. Keep variable names and defaults synchronized across `app.js`, `.env.example`, and the user-facing README.
- Sessions use the in-process Express store. Do not configure multiple application replicas without first replacing the session store with shared storage.
- `views/` and `public/` are served directly; there is no frontend framework or asset build step.

## Deployment Configuration

- Keep runtime versions in the native `package.json` engine declaration. Do not duplicate the Node version in `nixpacks.toml`.
- `nixpacks.toml` installs the non-default `ttyd` package and starts `ttyd` beside the Node process. Keep Express bound to the Coolify-provided `PORT` and keep `ttyd` inaccessible outside the container.
- Document Coolify UI-only settings and operator environment variables in the managed `## Coolify Deployment` README section, not in `nixpacks.toml`.
- Treat `deploy/` as the manual VPS alternative. Update its systemd and Caddy examples whenever paths, ports, process commands, or the `/ttyd` base path change.
