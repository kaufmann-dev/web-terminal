# OpenCode Terminal Glyphs Render Incorrectly

- Fixed: 2026-07-28 11:17:08 CEST (+0200)
- Pre-fix commit: `025075f3d42ab29ea798a4fc92787a6a82181ed7`

## Symptom

OpenCode's multi-row block logo contained visible horizontal gaps, and its animated Braille status
spinner appeared as a malformed partial box in the browser terminal. OpenCode otherwise operated
normally.

## Confirmed Root Cause

The browser terminal configured xterm.js with a `1.2` line height, which inserted space between
rows of OpenCode's block-character logo. Xterm.js 6 used its DOM renderer, which does not support
custom glyph rendering, while the self-hosted Latin-subset JetBrains Mono files did not supply
OpenCode's Braille spinner characters. The browser therefore rendered the spinner through an
inconsistent fallback glyph.

OpenCode's source defines the spinner with characters from the Unicode Braille Patterns range.
Xterm's WebGL addon supplies custom glyph definitions for that complete range.

## Changes

- Set the browser terminal line height to `1` so adjacent block-character rows remain continuous.
- Added the pinned xterm.js WebGL addon and served it through an authenticated same-origin vendor
  route.
- Load the WebGL renderer after opening each browser terminal and dispose it on context loss,
  restoring xterm's DOM renderer automatically.
- Retain the DOM renderer when WebGL initialization is unsupported or fails.
- Updated the terminal behavior and repository guidance.
