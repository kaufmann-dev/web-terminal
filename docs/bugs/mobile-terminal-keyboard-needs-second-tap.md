# Mobile Terminal Keyboard Needs a Second Tap

- Fixed: 2026-07-31 10:43:01 UTC (+0000)
- Pre-fix commit: `20d3defca392ecd9148ea130e7a32b9fb843c32d`

## Symptom

On mobile, tapping a ready terminal sometimes did not open the software keyboard until the user
tapped the terminal a second time. A one-finger drag still needed to scroll retained terminal
history without opening the keyboard.

## Confirmed Root Cause

xterm focuses its hidden textarea to receive keyboard input. The terminal's asynchronous WebSocket
ready callback focused that textarea on mobile even though an asynchronous focus cannot summon the
software keyboard. A runtime probe confirmed that the textarea was therefore already the active
element before the first user interaction.

The custom touch-scroll recognizer tracked the initial pointer gesture but left stationary taps to
the later synthetic `click` handler. That handler called `focus()` on the already-focused textarea,
which did not reliably create the focus transition mobile browsers need to reopen the keyboard.

## Changes

- Made touch release distinguish stationary taps, recognized gestures, and unrelated pointers.
- Focused a ready terminal synchronously from a stationary touch `pointerup`, briefly blurring an
  already-active textarea before refocusing it so a dismissed keyboard reopens.
- Kept recognized drag gestures keyboard-free and retained their synthetic-click suppression.
- Stopped the asynchronous ready callback from focusing the terminal on mobile while preserving
  desktop automatic focus.
- Added regression coverage for touch outcomes, first-tap focus, refocus, gesture suppression, and
  the mobile ready-state behavior.

## Verification

- JavaScript syntax checks passed for the Express entrypoint, session manager, browser terminal,
  and terminal-input module.
- All 55 Node tests passed, including the new touch-outcome and mobile-focus regressions.
