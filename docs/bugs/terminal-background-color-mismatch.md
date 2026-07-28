# Terminal Background Colors Do Not Match

- Fixed: 2026-07-28 11:42:53 CEST (+0200)
- Pre-fix commit: `bb39723799567d10046cc124102b22e67751648c`

## Symptom

The inset between the terminal workspace and the rendered xterm surface exposed a narrow strip
with a slightly different dark background color.

## Confirmed Root Cause

The terminal surface crossed three independently painted layers: the workspace, the terminal host,
and xterm's renderer. The CSS layers and the JavaScript xterm theme did not share a dedicated
terminal-background source of truth, allowing `#08090c` and `#0b0c10` to meet at the host inset.

## Changes

- Added one `--terminal-bg` theme property with the intended `#08090c` color.
- Applied it to both the terminal workspace and terminal host.
- Read the same property when configuring xterm's renderer.
- Added a regression test that requires all three layers to use the shared background.
