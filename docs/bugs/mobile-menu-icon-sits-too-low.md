# Mobile Menu Icon Sits Too Low

- Fixed: 2026-07-18 13:38:42 CEST (+0200)
- Pre-fix commit: `60592724d524f38c997b15a5766d8c719d72cd14`

## Symptom

The three strokes in the mobile session-menu button appeared lower than the adjacent active-session
label, both normally and while the button was focused or active.

## Confirmed Root Cause

The button used the Unicode `☰` character. Flexbox centered the character's font box, but the
visible strokes were not vertically centered within that box because their placement was governed
by the font's glyph metrics.

## Changes

- Replaced the font-dependent character with an aria-hidden CSS icon.
- Drew three evenly spaced strokes around the button's exact vertical center while preserving the
  existing accessible label and current-color hover behavior.
