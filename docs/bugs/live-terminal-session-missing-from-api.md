# Live Terminal Session Missing From API

- Fixed: 2026-07-17 20:35:12 CEST (+0200)
- Current commit: `8a897a3b9284daea98952226a3578f379debcfa5`

## Symptom

Creating a terminal session returned HTTP 503, and the session list stayed empty even though tmux
showed the new session and its Bash pane still running.

## Confirmed Root Cause

The tmux list format used literal tab characters as field separators. tmux replaced those control
characters with underscores, so the parser read the complete record as the session name. The
managed-name filter then rejected that value and hid every live session.

The two subsequent shell-startup changes did not affect the failure because the managed Bash pane
had never exited.

## Changes

- Replaced the tmux list field separator with a pipe, which cannot occur in a validated managed
  session name and is preserved by tmux.
- Restored the terminal startup file so applied user dotfiles and system Bash configuration load
  normally.
- Removed the error guard and README wording introduced by the ineffective shell-startup fixes.
