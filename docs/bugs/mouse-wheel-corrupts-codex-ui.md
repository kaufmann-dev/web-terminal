# Mouse Wheel Corrupts Codex UI

- Fixed: 2026-07-17 21:17:14 CEST (+0200)
- Current commit: `6f98500d6eea867bab41e1d973dbc6cb1ebfac57`

## Symptom

Using the mouse wheel while Codex was open made its terminal UI redraw incorrectly. The same wheel
gesture at a Bash prompt recalled previous commands instead of scrolling through terminal history.

## Confirmed Root Cause

The dedicated tmux server used its default `mouse off` setting. Because an attached tmux client uses
the alternate screen, ttyd's xterm.js converted wheel gestures into arrow-key input instead of
browser scrollback. tmux passed those keys to the active pane, where they mutated Codex's TUI state
and triggered the broken-looking redraws.

With tmux mouse mode enabled, the same Playwright wheel gesture entered tmux copy mode and did not
alter the shell input or active process.

## Changes

- Added a managed tmux configuration that enables mouse mode.
- Made both the Node session service and the attach-only ttyd wrapper use that configuration when
  connecting to the dedicated `web-terminal` tmux server.
- Documented copy-mode scrolling and its `q` exit key in the terminal behavior guide.
