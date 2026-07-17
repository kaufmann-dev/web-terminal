# Browser Disconnect Stops Terminal Work

- Fixed: 2026-07-17 22:51:00 CEST (+0200)
- Pre-fix commit: `aafda95b10ce9e061740fe90150b77b1a316947a`

## Symptom

Closing the terminal page, losing the browser connection, or logging out originally stopped the
active shell and foreground programs such as Codex. The intermediate tmux fix preserved work but
introduced a second terminal state and made scrolling unreliable.

## Confirmed Root Cause

ttyd originally owned the shell process and sent SIGHUP when its WebSocket client disconnected.
Moving the shell into tmux separated it from the browser lifetime, but ttyd and tmux then retained
independent terminal states.

## Changes

- Express now owns one `node-pty` Bash process per validated named session. WebSocket attachment is
  separate from PTY lifetime, so disconnect, refresh, session switching, and logout only detach the
  browser.
- Output produced without a browser is processed by headless xterm and included in the next ordered
  reconnect snapshot.
- A newer browser client replaces the older client without stopping the PTY.
- Natural shell exit removes the named session. Explicit deletion remains destructive and signals
  every process in the PTY's Linux session, escalating survivors after two seconds.
- Application shutdown performs the same PTY cleanup. Sessions remain process-local and do not
  survive application or container restarts.
