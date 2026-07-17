# Coolify WebSocket Origin Rejected

- Fixed: 2026-07-17 23:25:56 CEST (+0200)
- Pre-fix commit: `d4f5fdc89f718f36b84e94f387c72f3dadef4c44`

## Symptom

The authenticated terminal page loaded on Coolify and listed the `main` session, but the terminal
remained blank with “Connection lost. Reconnecting…” and zero attached clients.

## Confirmed Root Cause

The application tried to infer its browser-facing origin from reverse-proxy request headers. The
authority reconstructed inside Node did not match the browser's public origin on the deployed
Coolify proxy chain, so every upgrade was rejected before authentication or PTY attachment. Live
same-origin upgrade requests returned `403 WebSocket origin rejected` both before and after the
first forwarded-host change.

The earlier claim that Coolify specifically rewrote `Host` while providing a usable
`X-Forwarded-Host` was not confirmed. Its regression fixture constructed that assumed header
shape, so the passing test did not model the failing deployment.

## Changes

- Added required `PUBLIC_ORIGIN` configuration and validate it once during startup as an HTTP(S)
  origin without credentials, a path, a query, or a fragment.
- Compare every WebSocket `Origin` directly with the normalized configured origin. Forwarded host
  and protocol headers cannot alter this decision.
- Replaced the assumption-based proxy fixture with checks for configured-origin acceptance,
  attacker-origin rejection even with spoofed forwarding headers, and invalid configuration.
- Updated Coolify, local setup, troubleshooting, and repository guidance for the required origin.
