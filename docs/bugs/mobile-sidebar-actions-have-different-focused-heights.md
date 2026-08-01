# Mobile Sidebar Actions Have Different Focused Heights

- Fixed: 2026-08-01 12:07:35 UTC (+0000)
- Pre-fix commit: `5b3f6a7505b230f70b1514ace3eeec9ca6182e82`

## Symptom

On mobile, the Logout button and the adjacent sidebar close button had visibly different heights,
including while their focus outlines were shown.

## Confirmed Root Cause

The mobile Logout button inherited the shared Logout control's fixed `30px` height, while the
sidebar close button inherited the icon control's fixed `32px` height. Both controls used the same
focus outline, so focusing them preserved the underlying two-pixel height mismatch.

## Changes

- Set only the mobile Logout button to `32px`, matching the adjacent close button without changing
  the desktop Logout control.
- Added regression coverage for the mobile action height.
