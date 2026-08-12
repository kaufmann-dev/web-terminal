# iOS Session Name Input Zooms on Focus

- Fixed: 2026-08-12 18:53:31 UTC (+0000)
- Pre-fix commit: `e33662c263c09816b8c17eb80584b235a75c254f`

## Symptom

Focusing the new-session name field in iPhone Safari automatically zoomed the page, disrupting
the mobile session sidebar layout while the software keyboard was open.

## Confirmed Root Cause

The session-name input used a `12px` font size. Safari enlarges pages when a focused form control
uses text below its readable input threshold, so focusing this field triggered the browser zoom.

## Changes

- Increased the session-name input font size from `12px` to `16px`.
- Added a stylesheet regression assertion for the iOS-safe input size.

## Verification

The targeted mobile stylesheet suite passed all 10 tests on Node.js 24.18.0.
