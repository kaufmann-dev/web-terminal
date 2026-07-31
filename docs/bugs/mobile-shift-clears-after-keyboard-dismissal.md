# Mobile Shift Clears After Keyboard Dismissal

- Fixed: 2026-07-31 14:40:13 UTC (+0000)
- Pre-fix commit: `01585815b28cdcb474bbf0c45aa61a907455ad2f`

## Symptom

After manually dismissing the mobile software keyboard, the first Shift tap briefly armed Shift
and then immediately cleared it. A second tap worked. Ctrl and Alt could similarly fail to reopen
the keyboard on their first tap. Momentary controls such as Tab also had no safe visual press
feedback after native coarse-pointer `:active` styling was removed to stop flicker.

## Confirmed Root Cause

WebKit can leave xterm's hidden textarea focused with pending input or composition after the
software keyboard is dismissed. Blurring that textarea commits the pending input, and the first
blur can leave the textarea focused until a second focus-changing interaction. This matches the
focus and composition sequence documented in [WebKit bug 164369](https://bugs.webkit.org/show_bug.cgi?id=164369).

Commit `e62179f`, which came after `68024e6`, changed modifier handling to arm Shift before closing
the keyboard. The subsequent blur flushed stale textarea input through the newly armed Shift. The
one-shot modifier pipeline therefore consumed that input and cleared Shift, producing the brief
on-then-off state. Before `e62179f`, Shift blurred before it was armed, so this exact regression was
not present, although the older implementation still had the duplicate activation, focus theft,
and Ctrl/Alt reopening defects fixed by later commits.

The flicker-only commit `1f1a125` changed CSS tap highlighting and did not introduce event or focus
behavior. Rolling back to `68024e6` would therefore remove the Shift ordering regression but also
restore known control defects rather than address the shared keyboard transition correctly.

## Changes

- Centralized a modifier transition as one synchronous focus operation: flush and release an
  active textarea under the old modifier state, apply the requested modifier state, then refocus
  only when Ctrl or Alt requires the keyboard.
- Retry blur once, and only while the textarea remains active, to handle WebKit committing pending
  composition without releasing focus on its first blur. Internal xterm focus reports remain
  suppressed while ordinary pending input is forwarded unchanged.
- Keep Shift independently toggleable with the keyboard closed and keep Ctrl or Alt focused while
  either modifier remains armed.
- Add a 160 ms application-controlled blink for successfully activated momentary controls such as
  Tab. It runs after the existing deduplicated click activation, skips persistent modifier
  buttons, supports reduced motion, and cleans up on completion or cancellation without changing
  pointer, click, or focus behavior.
- Add regression coverage for a stale input commit that resists the first blur, modifier ordering,
  Ctrl keyboard focus, one-shot feedback wiring, coarse-pointer styling, and animation cleanup.

## Verification

- Targeted JavaScript syntax checks and all 24 mobile input and control tests passed.
- A Chromium iPhone-sized trusted-touch fixture loaded the actual updated input module and
  stylesheet. The first Shift tap flushed one stale character with two bounded blur attempts and
  remained armed; the second Shift tap disarmed it. Ctrl and Alt each kept the textarea focused
  while either was active, and every touch produced exactly one control activation.
- The same fixture sent exactly one Tab and started exactly one feedback animation for one Tab tap.
  Modifier taps started no transient animation, the animation class cleared after completion, and
  the browser reported no page errors.
