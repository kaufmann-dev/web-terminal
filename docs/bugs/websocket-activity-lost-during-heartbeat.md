# WebSocket Activity Is Lost During Heartbeat

- Fixed: 2026-07-29 13:49:26 UTC (+0000)
- Pre-fix commit: `34d76f62339d352df5ae30c6c4c0fce2aaaaaee4`

## Symptom

Interactive terminal input could update the WebSocket's in-memory activity timestamp without
reliably persisting it. The activity test failed intermittently, and a heartbeat near session
expiry could close an active user's connection.

## Confirmed Root Cause

Activity persistence reads and writes the session store asynchronously. The heartbeat could read
the older stored session while that write was in flight and replace the WebSocket's newer
in-memory session with it. The persistence callback then read the now-stale timestamp from the
socket, losing the activity update.

## Changes

- Captured the activity timestamp before beginning the asynchronous store operation.
- Prevented an older completed write from replacing newer in-memory activity.
- Made heartbeat session merges preserve the newest timestamp even while a persistence callback
  is in flight.
