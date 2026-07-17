# Browser Disconnect Stops Terminal Work

- Fixed: 2026-07-17 17:02:41 UTC (+0000)
- Current commit: `e83a86b3849868f622cda00f3cf16147ef589fbd`

## Symptom

Closing the terminal page, losing the browser connection, or logging out stopped the active shell and foreground programs such as Codex. Deleting an attached terminal session could also crash the Node process while handling the closed WebSocket.

## Confirmed Root Cause

`ttyd` spawned `/bin/bash` directly for each WebSocket client and sent its default SIGHUP when that client disconnected. The shell and its foreground process therefore belonged to the browser connection and exited with it. The proxy error callback also assumed its response argument was always an Express response, although WebSocket errors provide a raw socket.

## Changes

- Added application-managed sessions on the dedicated `web-terminal` tmux socket so browser connections attach and detach without owning the shell process.
- Added authenticated, CSRF-protected APIs and a responsive UI for listing, creating, opening, and deleting named sessions.
- Added an attach-only wrapper that validates the single ttyd URL argument before invoking tmux.
- Added tmux to both deployment paths and documented the session lifecycle.
- Updated the ttyd proxy error handler to handle both HTTP responses and WebSocket sockets without crashing Node.
