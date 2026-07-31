# iOS Dictation Normalizer Regresses Mobile Controls

- Fixed: 2026-07-31 15:42:14 UTC (+0000)
- Pre-fix commit: `847fa5fe56d96de3684fb9a84a411e1742d86225`

## Symptom

The attempted iOS dictation fix still appended overlapping interim transcripts on the deployed
iPhone. After manually dismissing the software keyboard, the first Ctrl tap could again fail to
open it. The mobile control strip also moved above the software keyboard inconsistently. The Enter
control itself was present and needed to remain.

## Confirmed Root Cause

Commit `fcb4535` was the only behavioral change between the last working modifier implementation
and the deployed build. It inserted a textarea-normalization state machine into xterm's
`beforeinput`, `input`, `onData`, and `blur` paths. Its fixture assumed dictation would always
produce matching synchronous `insertText` event data and xterm output. The real-device output
still consisted of appended cumulative snapshots, proving that assumption did not match the
target iPhone's event stream. The interception also changed the hidden textarea lifecycle used by
the already-tested Ctrl, Alt, and Shift keyboard transition.

The layout independently relied on `100dvh`. On iOS, the software keyboard can shrink or pan the
visual viewport without resizing the layout viewport represented by that CSS height. WebKit's
Visual Viewport API exposes the keyboard-visible height and offset and emits resize and scroll
events for those changes, but the page did not use it.

## Changes

- Removed the dictation normalizer, every added textarea capture and blur listener, its synthetic
  fixtures, and the false documentation claim. Voice dictation is intentionally left to xterm and
  may still repeat interim snapshots.
- Restored direct xterm `onData` handling and the exact pre-dictation mobile focus path, including
  the bounded stale-input blur retry that runs before a modifier is armed.
- Preserved the Enter control, its xterm-compatible carriage-return encoding, the deduplicated
  touch activation path, and momentary visual feedback.
- Measured the unzoomed `visualViewport` height and top offset, wrote its bottom edge to the mobile
  body height, and resynchronized it on visual-viewport resize and scroll, window resize, breakpoint
  changes, page visibility restoration, and window focus. Pinch zoom retains the layout viewport
  height rather than triggering a terminal reflow.
- Added regression coverage for keyboard-shrunken, panned, restored, unavailable, and pinch-zoomed
  viewport measurements, the listener wiring, and complete removal of dictation interception.

## Verification

- Both changed browser modules passed JavaScript syntax checks, and all 25 targeted mobile input
  and control tests passed.
- A 390x844 browser fixture loaded the actual input module and stylesheet. A simulated 475.25px
  keyboard-visible viewport placed both the body and control strip bottom at exactly 475.25px. A
  45px viewport offset retained that same visible bottom edge, and dismissal restored both to
  844px without page errors.
