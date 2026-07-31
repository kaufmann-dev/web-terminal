# Mobile Modifier Taps Close an Open Keyboard

- Fixed: 2026-07-31 21:05:52 UTC (+0000)
- Pre-fix commit: `2cdd0d855b2dfababaa7db555a81047ce13e1d72`

## Symptom

Tapping Shift while the mobile software keyboard was already open closed it, even though Shift
should only change the one-shot modifier state. Tapping an armed Ctrl or Alt to turn it off also
closed an open keyboard. Consuming Ctrl or Alt with a terminal key still needed to close the
keyboard.

## Confirmed Root Cause

Every mobile modifier tap used the same keyboard transition. That transition blurred xterm's
textarea, toggled the modifier, and refocused the textarea only when the final modifier set still
contained Ctrl or Alt. Shift alone and a deactivated Ctrl or Alt therefore left the textarea
blurred, so both actions closed a keyboard that had already been open.

A runtime probe against the pre-fix input module recorded a single `blur` and no `focus` for each
case, leaving the simulated textarea inactive after both an open-keyboard Shift tap and an
open-keyboard armed-Ctrl tap.

## Changes

- Decide keyboard behavior from the modifier action instead of the final combined modifier state.
- Open or reopen the keyboard only when Ctrl or Alt is being armed, retaining the bounded stale
  textarea flush before those modifiers become active.
- Toggle Shift and deactivate Ctrl or Alt without changing focus, preserving the keyboard's
  current visibility.
- Keep the existing one-shot consumption path that clears modifiers and closes the keyboard after
  a modified terminal key.
- Updated regression coverage and the README's mobile-control behavior description.

## Verification

- JavaScript syntax checks passed for every applicable module, all 25 targeted mobile input and
  control tests passed, and the complete 64-test Node suite passed.
- A Chromium runtime probe importing the actual input module confirmed that Shift preserved both
  closed and open textarea states, deactivating Ctrl preserved the open state, and consuming Ctrl
  with `c` produced `^C` and closed it.
