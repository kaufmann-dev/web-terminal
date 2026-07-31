# Mobile Terminal Controls Flicker on Tap

- Fixed: 2026-07-31 11:10:39 UTC (+0000)
- Pre-fix commit: `68024e62ff4c25174adbfac5421a61c33dd04804`

## Symptom

Mobile terminal controls performed the correct action once per physical touch, but still flashed
briefly on iPhone Safari before settling into the correct visual state.

## Confirmed Root Cause

The controls supplied their own normal, active, and armed styles but did not override WebKit's
native tap highlight. Safari therefore painted its translucent tap overlay independently of the
button's application-managed state. A browser probe confirmed that the inherited default tap
highlight was an 18%-black overlay.

The preceding touch-activation fix prevented duplicate actions but intentionally did not alter
browser painting, so it could not remove this separate visual flash.

## Changes

- Disabled WebKit's native tap overlay on the custom-styled mobile terminal keys.
- Retained the existing `:active` style for deliberate press feedback and the `aria-pressed` style
  for persistent modifier state.
- Added regression coverage requiring the transparent tap-highlight override.

## Verification

- All required JavaScript syntax checks passed.
- The complete Node test suite passed, including the mobile-control styling regression.
