# Background Terminal Output Replays on Return

- Fixed: 2026-07-27 21:04:33 CEST (+0200)
- Pre-fix commit: `b1783539adf6cc9579ed68798e040839f72a8c7a`

## Symptom

After leaving the browser page while Codex continued working, returning to it showed old Codex
frames advancing several times faster than real time. The terminal took additional time to catch
up instead of immediately showing Codex's current state.

## Confirmed Root Cause

The hidden browser page kept its terminal WebSocket attached and continued receiving every PTY
output chunk. Browser background throttling delayed xterm's queued write callbacks, while the
client serialized every later chunk behind those callbacks. When the page became visible again,
xterm rapidly processed that stale queue and visibly replayed Codex's intermediate frames.

The screencast showed Codex's elapsed counter advance from about 5:48 to 9:37 during an 81-second
recording. The client code confirmed that live binary messages remained attached and were appended
to a promise-backed xterm write queue regardless of page visibility.

## Changes

- Hidden pages now detach their terminal WebSocket and cancel pending reconnect attempts.
- Returning to a visible page opens a fresh connection and restores the headless terminal's latest
  bounded snapshot before live output resumes.
- Stale queued messages from an old WebSocket no longer write into the browser terminal.
- Updated the README to describe background detachment and current-state restoration.
