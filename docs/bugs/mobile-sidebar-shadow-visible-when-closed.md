# Mobile Sidebar Shadow Visible While Closed

- Fixed: 2026-07-28 12:01:42 CEST (+0200)
- Pre-fix commit: `752816eb34ff98b14b3dd7b45f7d364bad97b2fd`

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

- Removed the mobile sidebar box shadow completely, in both its closed and open states.
- Reverted the unrelated shared terminal-background property and restored the original workspace,
  host, and xterm background configuration.
- Added regression coverage requiring both mobile sidebar states to remain shadow-free.
