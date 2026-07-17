# Coolify WebSocket Origin Rejected

- Fixed: 2026-07-17 23:19:31 CEST (+0200)
- Pre-fix commit: `287c1aaadf23936f672e7548441112e43ad85abe`

## Symptom

The authenticated terminal page loaded on Coolify and listed the `main` session, but the terminal
remained blank with “Connection lost. Reconnecting…” and zero attached clients.

## Confirmed Root Cause

The WebSocket origin gate combined `X-Forwarded-Proto` with the backend `Host` header and ignored
`X-Forwarded-Host`. Coolify supplied the public HTTPS protocol but changed the authority seen by
the application, so the browser's public `Origin` never exactly matched the reconstructed backend
origin. A live same-origin WebSocket upgrade returned `403 WebSocket origin rejected`, while a
live CSRF response set `Secure` cookies and confirmed that HTTPS protocol reconstruction worked.

## Changes

- Reconstruct the expected origin from the first forwarded public host when present, falling back
  to the direct host for local connections.
- Normalize the reconstructed URL so default ports compare correctly, and reject malformed
  authorities containing credentials, paths, queries, or fragments.
- Added a WebSocket regression check shaped like Coolify's proxy request, including a forwarded
  HTTPS host with the default port.
- Updated the proxy guidance to name the forwarded host and protocol headers required by the
  same-origin gate.
