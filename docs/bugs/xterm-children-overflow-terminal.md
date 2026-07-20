# Xterm Children Overflow Terminal

- Fixed: 2026-07-20 08:28:34 UTC (+0000)
- Pre-fix commit: `ca51a3e292c1e2dd07bf425c6cbe6219d7e75b2a`

## Symptom

Xterm's viewport was taller than its generated screen and scrollable elements, leaving mismatched
terminal layers and unwanted space at the bottom.

## Confirmed Root Cause

FitAddon sizes the terminal grid to a whole number of rows, so the generated screen and scrollable
elements can legitimately be shorter than the available host by a fraction of a row. The
stylesheet forced xterm to occupy the host's full height, which also stretched its absolutely
positioned viewport while the screen and scrollable element retained the grid's exact height.

## Changes

- Kept the terminal host inset from the workspace so FitAddon measures the intended available
  area.
- Removed the forced xterm height so xterm, its viewport, the scrollable element, and the screen all
  use the rendered grid height.
