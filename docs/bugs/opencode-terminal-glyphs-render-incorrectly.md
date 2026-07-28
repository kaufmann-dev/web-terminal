# OpenCode Block Logo Has Horizontal Gaps

- Fixed: 2026-07-28 11:40:41 CEST (+0200)
- Pre-fix commit: `811764d1e0f4b44ae31fdac2121aa54f9e0bef1d`

## Symptom

OpenCode's multi-row block logo contained visible horizontal gaps. Its footer also contained blank
rows and a blue `▣` glyph whose thin right edge was difficult to see. OpenCode otherwise operated
normally.

## Confirmed Root Cause

The browser terminal configured xterm.js with a `1.2` line height, which inserted space between
rows of OpenCode's block-character logo.

The footer observations had separate causes. OpenCode deliberately emits one-row top margins
between its message sections and two spaces after the `▣` footer glyph, so terminal line height
cannot remove that spacing. The glyph itself renders correctly in the terminal's normal foreground
color; its blue appearance comes from OpenCode's agent color and small-size anti-aliasing. Switching
from xterm's DOM renderer to its WebGL addon did not correct it.

## Changes

- Set the browser terminal line height to `1` so adjacent block-character rows remain continuous.
- Retained xterm's default DOM renderer and removed the ineffective WebGL dependency, browser
  initialization, authenticated vendor route, and fallback path.
- Left OpenCode's upstream footer layout and theme styling unchanged.
- Updated the terminal behavior, tests, and repository guidance.
