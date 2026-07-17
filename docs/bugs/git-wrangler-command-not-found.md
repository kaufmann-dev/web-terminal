# Git Wrangler Command Not Found

- Fixed: 2026-07-17 23:33:30 CEST (+0200)
- Pre-fix commit: `59b7a051a6d77e8178fe75c75bdb0deaa0207e2e`

## Symptom

Running `git-wrangler` in a deployed browser terminal returned
`bash: git-wrangler: command not found`, even though the Nixpacks build completed successfully.

## Confirmed Root Cause

The pinned installer correctly placed the verified Git Wrangler 0.12.0 binary at
`/usr/local/bin/git-wrangler`, but the Nixpacks runtime `PATH` did not contain `/usr/local/bin`.
Both terminal-environment constructors preserved that incomplete image path without adding the
custom installation directory.

The exact generated Nixpacks image reproduced the failure: the binary ran successfully by its
absolute path and reported version 0.12.0, while `command -v git-wrangler` and the bare command
failed inside the managed terminal environment.

## Changes

- Added `/usr/local/bin` explicitly after the application and user binary directories in both the
  PTY environment and the startup environment used for dotfile management.
- Added a regression check for terminal PATH ordering when the underlying image path omits
  `/usr/local/bin`.
- Updated the environment documentation to describe where Git Wrangler is installed and how the
  terminal PATH exposes it.
