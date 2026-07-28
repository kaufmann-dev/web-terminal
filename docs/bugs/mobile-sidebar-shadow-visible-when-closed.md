# Mobile Sidebar Shadow Visible While Closed

- Fixed: 2026-07-28 11:59:21 CEST (+0200)
- Pre-fix commit: `feb4e638ed086ff949fa850e0580fda05b0ebb6b`

## Symptom

On mobile, closing the session sidebar left a narrow, slightly darker vertical strip along the
entire left edge of the terminal.

## Confirmed Root Cause

The mobile sidebar's closed state translated the sidebar fully off-screen but kept its
`12px 0 0 rgb(0 0 0 / 22%)` box shadow active. The browser continued compositing that shadow over
the terminal workspace, producing the uniform dark strip. It appeared only at the mobile
breakpoint because the off-canvas sidebar and its shadow are mobile-only.

Screenshot pixel inspection showed a full-height strip with a uniform boundary, and its rendered
width matched the configured sidebar shadow. Earlier changes that unified terminal background
colors did not affect the strip, confirming that xterm and terminal application rendering were
unrelated.

## Changes

- Removed the box shadow from the closed mobile sidebar state and apply it only while
  `.sessions-open` is active.
- Reverted the unrelated shared terminal-background property and restored the original workspace,
  host, and xterm background configuration.
- Added regression coverage requiring the closed mobile sidebar to have no shadow and the open
  sidebar to retain it.
