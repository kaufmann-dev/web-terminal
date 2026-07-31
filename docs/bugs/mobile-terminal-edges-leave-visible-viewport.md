# Mobile Terminal Edges Leave the Visible Viewport

- Fixed: 2026-07-31 21:30:35 UTC (+0000)
- Pre-fix commit: `cd4acb81c37a262811c8a9d493fb235aa4f49596`

## Symptom

After moving the mobile control strip below the header and making the software keyboard overlay the
terminal, Safari sometimes hid the terminal's bottom behind its browser toolbar. During or after
keyboard focus, Safari could also move both the header and the control strip completely above the
visible screen.

## Confirmed Root Cause

The keyboard-overlay change removed the mobile `100dvh` height and left the terminal body at the
base `100vh`. On mobile Safari, `100vh` represents the large viewport, so the body can extend behind
expanded browser chrome. The supplied device screenshots showed the terminal continuing into the
bottom toolbar, and the pre-fix browser probe measured a full `844px` body in a representative
shorter visible region.

Safari can independently pan its visual viewport to keep a focused input visible. The header and
control strip remained at layout coordinates `0–105px`, so a visual-viewport top offset greater
than `105px` removed both from view. A runtime geometry probe confirmed that exact outcome. WebKit
also documents delayed and inconsistent keyboard-related `visualViewport.offsetTop` reporting in
[bug 237851](https://bugs.webkit.org/show_bug.cgi?id=237851).

## Changes

- Restore mobile `100dvh` sizing so the resting terminal follows browser chrome without measuring
  or applying the keyboard-reduced visual-viewport height.
- Read only the unzoomed visual viewport's top offset and translate the header and control strip by
  that amount, leaving the terminal position and dimensions unchanged.
- Resample the offset after two animation frames on visual-viewport resize and scroll, window
  resize, breakpoint changes, visibility restoration, and window focus.
- Keep the translated controls below the header and below the sidebar/backdrop stacking layers.
- Add regression coverage and update the README's mobile viewport contract.

## Verification

- JavaScript syntax checks, all 25 targeted mobile input and layout tests, and the complete 64-test
  Node suite passed.
- A browser fixture at `390x724` placed the resting body bottom at `724px`. Applying a simulated
  `106px` unzoomed Safari pan moved the header to `106px` and the controls directly below it while
  the terminal workspace remained at the same position and height.
