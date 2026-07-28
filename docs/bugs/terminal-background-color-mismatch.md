# Terminal Background Colors Do Not Match

- Fixed: 2026-07-28 11:51:27 CEST (+0200)
- Pre-fix commit: `f37e0f5f3ada88acf282b9af72df746c512ebe5f`

## Symptom

The inset between the terminal workspace and the rendered xterm surface exposed a narrow strip
with a slightly different dark background color.

## Confirmed Root Cause

The terminal surface crossed three independently painted layers: the workspace, the terminal host,
and xterm's renderer. The CSS layers and the JavaScript xterm theme did not share a dedicated
terminal-background source of truth.

The first attempted correction chose the workspace's `#08090c` as that shared color. It did not
remove the seam because terminal applications can supply explicit cell backgrounds that take
precedence over xterm's default theme. The surrounding layers therefore need to match the actual
xterm surface color, `#0b0c10`, instead of trying to recolor terminal output.

## Changes

- Added one `--terminal-bg` theme property using xterm's `#0b0c10` surface color.
- Applied it to both the terminal workspace and terminal host.
- Read the same property when configuring xterm's renderer.
- Added a regression test that requires all three layers to use the shared background.
