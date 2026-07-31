# Mobile Terminal Controls Corrupt Terminal Focus

- Fixed: 2026-07-31 11:51:14 UTC (+0000)
- Pre-fix commit: `1f1a1259064371e2db22acef6b94b88023cb4363`

## Symptom

On iPhone Safari, Ctrl and Alt intermittently failed to reopen the software keyboard. Pressing a
mobile terminal control could also make a focus-aware terminal application redraw or move its
cursor even though the user had not tapped the terminal surface.

The full control audit also found that modifier order could leave Ctrl or Alt armed with a closed
keyboard, delayed clipboard results could consume a newer modifier, stale touches could cross a
session change, and a disconnect could leave an unusable keyboard open.

## Confirmed Root Cause

xterm receives keyboard input through a hidden textarea. Ctrl and Alt called `focus()` directly,
which is a no-op when Safari has dismissed the software keyboard but has left that textarea as
`document.activeElement`. Unlike the terminal-surface tap path, the modifier path did not first
blur an already-active textarea before refocusing it inside the trusted user activation.

The control strip also allowed a button's native pointer default to steal textarea focus before
its document-level `pointerup` activation. That race was exposed when commit `68024e6` moved touch
activation ahead of the later compatibility click; the bare Ctrl/Alt focus behavior itself was
older. The following CSS-only flicker fix did not change event behavior.

Each xterm textarea focus or blur can synchronously emit `ESC [ I` or `ESC [ O` when the foreground
application enables DEC focus reporting. The browser client forwarded those internal
keyboard-management reports to the PTY, so a TUI could interpret a toolbar tap as a genuine
terminal focus change and redraw its cursor.

Clipboard reads and image uploads were applied asynchronously through normal xterm input. A
modifier armed after the Paste tap could therefore transform or consume the delayed result. The
touch guard also tracked neither movement nor controller identity and depended on a broad
time-based compatibility-click check.

## Changes

- Prevent native toolbar focus on valid touch pointerdown and mouse down, then activate from one
  identity-matched capture-phase click while rejecting drags, release mismatches, duplicate clicks,
  canceled gestures, stale controllers, and retargeted compatibility clicks.
- Preserve native keyboard and assistive-technology button activation without transferring DOM
  focus away before the updated `aria-pressed` state can be announced.
- Centralize mobile keyboard focus changes. Reopen an already-active xterm textarea with a
  synchronous blur/focus pair and suppress only the focus reports generated during those internal
  transitions; genuine terminal and page focus reports remain unchanged.
- Make keyboard visibility state-driven: Ctrl or Alt keeps it open in every modifier combination,
  while Shift alone keeps it closed. Modifier consumption and visible disconnect paths close it.
- Request clipboard access during the trusted tap, apply results in tap order, and bypass modifiers
  around programmatic key and paste injection so a later modifier remains untouched.
- Reset pending control gestures on cancellation, layout changes, visibility changes, connection
  state changes, session replacement, and disposal.

## Verification

- JavaScript syntax checks passed for the Express entrypoint, terminal session manager, browser
  terminal, and terminal-input module.
- All 62 Node tests passed, including focus-report suppression, already-focused keyboard reopening,
  modifier combinations, duplicate and retargeted clicks, drag cancellation, controller identity,
  accessibility fallback, ordered paste wiring, and lifecycle reset coverage.
- A browser DOM focus trace confirmed that reopening performs blur then focus, leaves the textarea
  active, forwards zero internal focus reports, and leaves terminal buffer coordinates, scrollback,
  and page scroll unchanged. A genuine terminal focus still forwards its focus-in report. A
  browser primary-touch trace activated Ctrl exactly once per tap, kept native button focus away
  from the toolbar, and let the second tap turn Ctrl off without emitting any terminal focus bytes.
