# Delayed Terminal Reconnect After Browser Resume

- Fixed: 2026-07-18 00:52:12 CEST (+0200)
- Pre-fix commit: `b8d6f2324bae83cc0c4900d68931bd9064572376`

## Symptom

After a device, browser, or network suspension, the terminal could remain disconnected for several
seconds after the tab became visible or browser connectivity returned. The reconnect status could
appear repeatedly even though the application server was available again.

## Confirmed Root Cause

The server and reverse proxy remained healthy. A suspended or disconnected browser stopped
answering WebSocket heartbeats, so the server correctly terminated the stale connection. The
browser then used exponential reconnect backoff capped at five seconds, but it had no wake-up path
for browser `online` or visible-tab events. Recovery therefore waited for whichever backoff timer
was pending after connectivity returned.

## Changes

- Extracted the reconnect attempt from timer scheduling and guarded it so only one request can run
  at a time.
- Consumed a pending backoff immediately when the browser comes online or the document becomes
  visible.
- Remembered resume signals received during an in-flight reconnect attempt so that race does not
  lose the immediate retry.
- Preserved the existing retry backoff when connectivity is still unavailable and left healthy or
  connecting sockets untouched.
- Documented the resume behavior in the README.
