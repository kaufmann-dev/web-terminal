# Mobile Terminal Controls Break After Flicker Fix

- Fixed: 2026-07-31 12:51:13 UTC (+0000)
- Pre-fix commit: `e24a399f1cf34cf6f8e9112a3299d2f87ec1a70c`

## Symptom

The attempted mobile-control flicker fix made the controls malfunction again on the target mobile
browser. Before that regression, controls eventually performed the correct action but briefly
showed the wrong visual state during a tap, especially when turning off an armed modifier.

## Confirmed Root Cause

Commit `e24a399` coupled a visual fix to an unnecessary event-contract rewrite. It moved touch
activation from the identity-matched compatibility `click` back to `pointerup`, reversing the
known-good Safari keyboard and focus path established by commit `e62179f`. Its Chromium fixture
encoded that new pointerup assumption and therefore could not validate the iPhone Safari behavior
that the change broke.

The visual flash did not require any event change. The browser applies the CSS `:active` pseudo-
class to its compatibility click before a capture-phase handler can suppress the event. On a
coarse touch pointer, that transient browser-controlled style could contradict the application's
`aria-pressed` modifier state. The existing transparent WebKit tap highlight was still intact.

## Changes

- Reverted every JavaScript, touch-guard, feedback-marker, test, and historical-note change from
  the broken flicker fix, restoring identity-matched click activation and all existing focus,
  keyboard, drag, cancellation, controller-identity, and duplicate-click behavior.
- Limited native `:active` button styling to hover-capable fine pointers. Coarse touch pointers now
  render only the stable application-managed `aria-pressed` state.
- Retained the transparent WebKit tap highlight, keyboard focus-visible styling, and mouse press
  feedback.
- Added a CSS regression assertion without changing the control-event regression expectations.

## Verification

- JavaScript syntax checks passed for the Express entrypoint, terminal session manager, browser
  terminal, and terminal-input module.
- All 62 Node tests passed with the restored event-contract expectations and the CSS regression.
- A Chromium mobile primary-touch trace using the restored activation guard, focus manager, click
  handler contract, and actual project stylesheet produced exactly two activations for two Ctrl
  taps. The first tap focused the terminal input, the second blurred it, and neither compatibility
  click changed the computed color through native `:active` styling.
