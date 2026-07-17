# Mouse Wheel Shows Duplicated Codex Screens

- Fixed: 2026-07-17 22:51:00 CEST (+0200)
- Pre-fix commit: `aafda95b10ce9e061740fe90150b77b1a316947a`

## Symptom

Wheel input in Codex either became arrow-key input or exposed duplicated and partially redrawn
loading screens, prompts, and intermediate frames instead of a coherent conversation. A later
key-routing workaround opened Codex's transcript pager, but scrolling then changed application
mode rather than behaving like normal terminal scrollback.

## Confirmed Root Cause

ttyd, tmux, and the browser each maintained terminal state. With tmux mouse handling disabled,
ttyd converted wheel gestures into keyboard input that reached Codex. With tmux copy mode enabled,
scrolling exposed tmux's history of Codex's inline redraw frames; tmux could not reconstruct a
logical transcript from those frames. The Codex-specific tmux bindings only diverted the gesture
into a separate alternate-screen pager and left the competing terminal states in place.

The final pre-fix reproduction used pinned Codex 0.144.5 in the Nixpacks image. Its live UI reported
`alternate_on=0`; the ordinary wheel path reported `pane_mode=1` and showed a composite of
onboarding, startup, and redraw frames. The workaround instead reported `alternate_on=1` because
it had opened `/TRANSCRIPT`.

## Changes

- Replaced the ttyd iframe and tmux attachment stack with an in-page xterm.js terminal connected to
  an authenticated, exact-same-origin WebSocket.
- Replaced tmux sessions with process-local named `node-pty` shells owned by Express.
- Added a headless xterm with 10,000 lines of scrollback and ordered serialization so reconnects
  restore one bounded terminal state before live output resumes.
- Let browser xterm handle wheel scrolling directly, with no Codex detection, synthetic keypresses,
  tmux copy mode, or transcript-pager routing.
- Removed ttyd, tmux, their proxy and service configuration, and the Codex Bash wrapper.
