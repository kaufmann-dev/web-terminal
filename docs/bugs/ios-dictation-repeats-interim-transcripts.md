# iOS Dictation Repeats Interim Transcripts

- Fixed: 2026-07-31 15:19:30 UTC (+0000)
- Pre-fix commit: `59ff33b131fec8b830ae77bf37290934b5814b2c`

## Symptom

Dictating `hallo Test Test 123` into the mobile terminal produced
`halhallohallo Test Testhallo Test Test 12hallo Test Test 123hallo Test Test 123`.
Ordinary typing and the mobile terminal controls behaved correctly.

## Confirmed Root Cause

iOS dictation replaces the hidden xterm textarea with successive complete transcript snapshots.
The observed output separates exactly into `hal`, `hallo`, `hallo Test Test`,
`hallo Test Test 12`, and two copies of `hallo Test Test 123`.

Pinned xterm 6.0.0 handles speech input through `InputEvent`, but its `insertText` path forwards
every event's complete `data` value directly through `onData`. It does not compare the textarea
value before and after the browser replacement, so the PTY appends every interim snapshot. A
browser reproduction dispatched those six snapshots through the real pinned xterm and produced
the reported string byte-for-byte.

[WebKit bug 261764](https://bugs.webkit.org/show_bug.cgi?id=261764) confirms that iOS and iPadOS
dictation emits `beforeinput` and `input` without the composition events that xterm's composition
helper expects. The issue remains open, and current xterm source retains the same direct
`insertText.data` forwarding path, so changing dependency versions would not fix this behavior.

## Changes

- Capture the xterm textarea value during `beforeinput` and again during the parent capture phase
  of `input`, before xterm's target listener emits `onData`.
- Normalize the matching synchronous xterm data into the terminal edit needed to reach the new
  textarea value. Growing dictation snapshots send only their new suffix, identical final
  snapshots send nothing, and revised earlier text sends normal terminal Delete bytes followed by
  the corrected tail.
- Leave ordinary incremental typing, programmatic key and paste input, internal focus reports,
  modifier transformation, and unmatched xterm data unchanged.
- Clear unconsumed event state in a microtask, resynchronize after textarea blur, and remove every
  added listener when a terminal controller is disposed.
- Add regression coverage for the exact reported transcript, ordinary repeated characters,
  revised dictation, unmatched input, listener wiring, normalization order, and empty-event
  suppression.

## Verification

- Both changed browser modules passed JavaScript syntax checks, and all 26 targeted mobile input
  and control tests passed.
- A Chromium iPhone-sized fixture loaded the actual pinned xterm and updated input normalizer.
  Xterm emitted all six complete reported snapshots, while the normalized stream was `hal`, `lo`,
  ` Test Test`, ` 12`, and `3`, yielding exactly `hallo Test Test 123`.
- The same real-xterm fixture preserved two ordinary `a` input events as `aa` rather than treating
  the repeated character as a duplicate snapshot.
