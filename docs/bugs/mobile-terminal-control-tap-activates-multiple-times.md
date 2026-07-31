# Mobile Terminal Control Tap Activates Multiple Times

- Fixed: 2026-07-31 11:03:38 UTC (+0000)
- Pre-fix commit: `908f06c316caf4cecec14893b74dec64c6b05168`

## Symptom

On iPhone Safari, one physical tap on a mobile terminal control could register two or four
activations. A Shift tap could therefore arm and immediately disarm the modifier, while ordinary
terminal keys could send their input multiple times.

## Confirmed Root Cause

The mobile control strip delegated every browser `click` directly to the active terminal without
tracking the touch that produced it or suppressing compatibility clicks after a handled touch.
Every click delivered by the browser was therefore treated as a separate user action. A browser
probe of the existing toggle path delivered four click events, invoked the handler four times, and
left Shift unarmed, matching the reported symptom.

This unguarded click path was introduced with the original mobile controls. The later terminal
surface change that focused the keyboard on the first stationary tap did not attach handlers to
the separate mobile control strip.

## Changes

- Track primary touch gestures by pointer ID and control action, activating only when the same
  touch ends on the same enabled control.
- Suppress non-keyboard compatibility clicks for one second after a handled touch while preserving
  distinct rapid touches and keyboard or assistive-technology activation.
- Keep click handling as the fallback for non-touch input and let pointer cancellation prevent
  horizontal control-strip scrolling from activating a key.
- Added unit and integration regression coverage for duplicated clicks, separate taps, canceled or
  mismatched gestures, and keyboard clicks.

## Verification

- JavaScript syntax checks passed for the Express entrypoint, session manager, browser terminal,
  and terminal-input module.
- The complete Node test suite passed, including the new touch-activation regressions.
