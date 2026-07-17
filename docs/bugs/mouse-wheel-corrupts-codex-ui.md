# Mouse Wheel Shows Duplicated Codex Screens

- Fixed: 2026-07-17 21:47:21 CEST (+0200)
- Current commit: `8695e5b75639a48ad6195cbf97558a39b6c92c78`

## Symptom

Using the mouse wheel while Codex was open first made its UI redraw incorrectly. Enabling tmux copy
mode stopped that input corruption, but scrolling then showed duplicated Codex loading screens,
prompts, and other intermediate redraws instead of a usable conversation transcript.

## Confirmed Root Cause

With tmux mouse mode disabled, ttyd's xterm.js converted wheel gestures into arrow-key input and
tmux passed those keys to Codex. Enabling mouse mode prevented that corruption by entering tmux copy
mode, but tmux only stores terminal output. Codex 0.144.5 renders its normal UI inline, so each UI
refresh can become a separate tmux history frame. tmux cannot reconstruct Codex's logical transcript
from those frames.

Codex's built-in transcript pager, opened with `Ctrl+T`, renders the actual conversation cleanly and
accepts `PageUp` and `PageDown`. In the reproduced Nixpacks image, the bad path reported
`pane_mode=1` with duplicated frames, while the Codex pager reported `pane_mode=0` and
`alternate_on=1` with a `/TRANSCRIPT` header.

## Changes

- Kept tmux mouse mode enabled so wheel gestures never become arrow-key input.
- Added a managed Bash wrapper around the pinned `codex` executable. It marks the active tmux pane
  while Codex runs and clears that state when Codex exits.
- Routed wheel-up in Codex to its built-in transcript pager and subsequent wheel gestures to
  `PageUp` and `PageDown`. The bindings track pager exit keys and reset state during Codex onboarding.
- Preserved normal tmux copy-mode scrolling for Bash and other terminal programs.
- Updated the terminal behavior guide to describe the two scrolling paths.
