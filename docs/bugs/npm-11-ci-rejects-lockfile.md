# npm 11 Clean Install Rejects Lockfile

- Fixed: 2026-07-29 16:15:23 UTC (+0000)
- Pre-fix commit: `38feedca23f29bff16d908f8316c63c31bac97da`

## Symptom

The Coolify image build completed the CentOS package layer and compiled xdotool, then failed at
`npm ci --omit=dev`. npm reported that `package.json` and `package-lock.json` were out of sync
because `@emnapi/core@1.11.3` and `@emnapi/runtime@1.11.3` were missing from the lockfile.

## Confirmed Root Cause

The repository lockfile had been accepted by the local npm 11.6.1 installation, but the maintained
CentOS Stream 10 package supplied npm 11.16.0. Reproducing `npm ci --omit=dev --dry-run` with npm
11.16.0 produced the same two missing-peer errors as Coolify. Regenerating the lock with that exact
npm release added the peer dependency records required by the current resolver.

The exact clean-install check also showed that npm 11.16 blocks dependency lifecycle scripts unless
they are covered by `allowScripts`. This project requires the installation scripts from
`agent-browser`, `node-pty`, and `opencode-ai`; leaving them unapproved would produce an image
without the required native executables even after the lockfile error was fixed.

## Changes

- Regenerated `package-lock.json` with npm 11.16.0 so its peer dependency graph passes the deployed
  npm resolver.
- Added version-pinned `allowScripts` entries for only `agent-browser`, `node-pty`, and
  `opencode-ai`.
- Made the image build load `node-pty` and run both installed CLI versions immediately after
  `npm ci`, so a skipped or failed lifecycle script cannot produce a broken deployment image.
- Added image-contract coverage that keeps each approval aligned with its exact dependency
  version.
- Documented the narrow lifecycle-script policy in the repository instructions.

## Verification

`npm ci --omit=dev` completed with npm 11.16.0 without lockfile or unapproved-script warnings,
audited 165 packages with zero vulnerabilities, and built a working `node-pty` process.
