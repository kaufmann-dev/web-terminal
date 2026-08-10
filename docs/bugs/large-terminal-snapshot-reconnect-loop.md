# Large Terminal Snapshot Reconnect Loop

- Fixed: 2026-08-10 10:57:59 UTC (+0000)
- Pre-fix commit: `9bec8f3a9c2bfab901f2e0fca3def17b57ac043f`

## Symptom

A terminal with substantial retained scrollback could alternate indefinitely between
“Connection lost. Reconnecting…” and a brief “Restoring terminal…”. Closing that terminal and
creating a new one appeared to fix the connection because the new session had a small snapshot.

## Confirmed Root Cause

The server used the same 1 MiB buffered-output limit for ordinary live output and the bounded
reconnect snapshot. A valid snapshot could exceed 1 MiB. After sending such a snapshot, the
server checked the WebSocket's now-large buffer before sending the `ready` message and closed the
client as too slow. Every reconnect attempted the same snapshot and repeated the failure.

A runtime reproduction created a real 10,000-line, 200-column headless-xterm snapshot measuring
2,014,623 bytes. Before the fix, the server sent the snapshot, omitted `ready`, closed with code
4005, and reported a failed attachment.

## Changes

- Treat the bytes buffered by the one-time restoration snapshot as a temporary allowance in
  addition to the live-output limit.
- Reduce and then remove that allowance as the WebSocket buffer drains, preserving the existing
  1 MiB protection against a client that falls behind on new terminal output.
- Added regression coverage for a snapshot larger than the live-output limit and for restoring
  the ordinary limit after the snapshot drains.

## Verification

The same 2,014,623-byte runtime reproduction now sends `snapshot`, the binary terminal state, and
`ready`, remains open, and reports a successful attachment.
