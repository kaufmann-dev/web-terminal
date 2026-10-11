# Server Environment Leaks Into Terminals

- Fixed: 2026-10-11 13:25:48 UTC (+0000)
- Pre-fix commit: `3f4ed7ccbfac5c413543e5f9c4f8c09a5e16f169`

## Symptom

`npm install -D <package>` in a project opened in the web terminal recorded the packages in
`package.json` and `package-lock.json` but did not install them into `node_modules`. Every
terminal shell had `NODE_ENV=production`, which makes npm omit development dependencies. The
same shells also inherited `PORT=3000` and `HOST=0.0.0.0`, so a project server that honors
those variables tried to bind the web terminal's own port.

## Confirmed Root Cause

`Dockerfile` sets `ENV NODE_ENV=production` since the CentOS Stream 10 migration (`434725b`,
2026-07-29), and Coolify supplies `PORT`, `HOST`, `PUBLIC_ORIGIN`, `TRUST_PROXY`,
`SOURCE_COMMIT`, and `COOLIFY_*` metadata to the container. `createTerminalEnvironment` in
`app.js` copies `process.env` into every PTY and scheduled job and removed only credentials and
`LC_ALL`; `run_in_terminal_environment` in `scripts/start.sh` did the same for chezmoi. These
values configure only the web-terminal server: `app.js` already defaults `NODE_ENV` to
`production`, and no terminal tool reads the deployment metadata.

## Changes

- Removed `NODE_ENV`, `PORT`, `HOST`, `PUBLIC_ORIGIN`, `TRUST_PROXY`, `SOURCE_COMMIT`, and the
  `COOLIFY_*` metadata from terminal sessions, scheduled jobs, and the chezmoi environment.
- Added regression coverage for the terminal environment and for keeping the `app.js` and
  `scripts/start.sh` lists identical.
- Already-open terminal sessions keep the old values until they are restarted.
