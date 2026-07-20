# Terminal Content Touches Browser Edge

- Fixed: 2026-07-20 07:15:38 UTC (+0000)
- Pre-fix commit: `94e8269748e4442a32411bb2950c13f081c4ecb4`

## Symptom

When terminal output reached the final visible row, its bottom pixels appeared against the browser
edge instead of retaining the terminal's intended inset.

## Confirmed Root Cause

The terminal host owned the visual padding, but xterm's FitAddon calculates rows from the host's
full computed dimensions and subtracts only padding applied to xterm's own element. It therefore
allocated rows into the host's padded area, where `overflow: hidden` clipped away the intended
bottom spacing.

## Changes

- Moved the existing 8px vertical and 10px horizontal inset from the terminal host to xterm's
  element so FitAddon excludes it when calculating terminal rows and columns.
