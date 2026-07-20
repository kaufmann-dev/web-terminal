# Xterm Children Overflow Terminal

- Fixed: 2026-07-20 08:19:14 UTC (+0000)
- Pre-fix commit: `b36116c15c44ae9a78d8ecc4bbbd1ec55ee42eae`

## Symptom

At some browser heights, xterm's generated screen and scrollable elements extended below the
terminal element. Terminal content reached the browser edge and an additional scrollbar or edge
appeared.

## Confirmed Root Cause

The terminal host used border-box sizing with 8px vertical padding. Xterm's FitAddon calculated
rows from the host's full computed height, while the terminal element occupied only the host's
smaller content box. Row rounding hid the mismatch at some heights, but at a 1209x849 viewport the
798px generated elements overflowed the 785px terminal element by 13px.

## Changes

- Replaced padding on the terminal host with equivalent workspace-relative insets.
- Kept the terminal host and xterm element the same size so generated children fit within both.
