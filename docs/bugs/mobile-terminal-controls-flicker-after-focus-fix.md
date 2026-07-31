# Mobile Terminal Controls Flicker After Focus Fix

- Fixed: 2026-07-31 12:21:58 UTC (+0000)
- Pre-fix commit: `e62179fcc43a44f7fc2c1baf8a4c1db094ebec43`

## Symptom

Mobile terminal controls flickered again when tapped. Modifier buttons could briefly show the
wrong visual state even though each tap eventually produced the correct result. The flash was
especially visible when a second tap turned Shift, Ctrl, or Alt off.

## Confirmed Root Cause

The focus-stability fix in the pre-fix commit moved touch activation from `pointerup` to the later
browser-generated compatibility `click`. Before the capture-phase click handler could suppress
that click or update the modifier, the browser applied the button's CSS `:active` style. Turning a
modifier off therefore changed it to the normal application state at the same time that the
compatibility click temporarily painted it as selected.

The earlier WebKit tap-highlight fix was still present. This regression came from the new event
timing combined with browser-controlled `:active` painting, not from restoration of the native
tap-highlight overlay.

## Changes

- Return a valid tracked activation from `pointerup`, apply it synchronously during that trusted
  release event, and retain the completed touch only to suppress its compatibility clicks.
- Drive touch press feedback with a tracked `data-touch-active` marker. Clear it on movement,
  release, cancellation, reset, session invalidation, layout changes, and page visibility changes.
- Limit native CSS `:active` feedback to hover-capable fine pointers so a compatibility click from
  a coarse touch pointer cannot repaint a released control.
- Preserve native keyboard and assistive-technology click fallback, release-target and controller
  validation, drag rejection, duplicate-click suppression, and the existing transparent WebKit
  tap highlight.

## Verification

- JavaScript syntax checks passed for the Express entrypoint, terminal session manager, browser
  terminal, and terminal-input module.
- All 62 Node tests passed, including the targeted mobile control and terminal-input regressions.
- A Chromium mobile primary-touch trace confirmed that one tap changes the modifier state at
  release, its compatibility click cannot change or repaint that state, and a second tap turns the
  modifier off without a selected-state flash.
