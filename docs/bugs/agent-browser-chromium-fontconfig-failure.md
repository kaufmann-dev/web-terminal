# Agent-browser Chromium Fontconfig Failure

- Fixed: 2026-07-20 07:41:06 UTC (+0000)
- Pre-fix commit: `f192881a3fe12b964a62b7fec8746dbb503d2ad6`

## Symptom

Unprefixed `agent-browser open` commands in the deployed web terminal could time out, lose the
Chromium process, reset the CDP connection, or return `about:blank`. Chromium logged
`Fontconfig error: Cannot load default config file: No such file: (null)`. Supplying the Nix
Fontconfig configuration through `FONTCONFIG_FILE` and `FONTCONFIG_PATH` made headless browser
commands work.

## Confirmed Root Cause

The generated Nixpacks environment installed Chromium but omitted Fontconfig's separate `out`
output. The pinned Nixpkgs Fontconfig derivation installs command-line programs from its `bin`
output by default, while its generated `fonts.conf` and `conf.d` tree live in `fontconfig.out`.
Chromium's Nix wrapper did not export Fontconfig paths, and the image had no default `/etc/fonts`
configuration, so Chromium started without the configuration required by its Fontconfig library.

The generated Nixpacks expression confirmed the missing output and the stable profile layout. The
deployed failure disappeared when the same Nix-provided configuration was supplied explicitly.
The later CSRF timing failure and headed Chromium's missing X server were unrelated.

## Changes

- Added `fontconfig.out` to the Nixpacks package environment so its configuration is available at
  the hash-independent `/root/.nix-profile/etc/fonts` path.
- Exported stable `FONTCONFIG_FILE` and `FONTCONFIG_PATH` image variables and retained them in every
  managed terminal environment without exposing Express authentication secrets.
- Added Nixpacks and uv to the immutable terminal toolset; Podman remains an external build-host
  tool because the Coolify application is not a nested container runtime.
- Added regression coverage for the image configuration and the PTY's Fontconfig environment.
- Updated deployment and runtime documentation for headless agent-browser and container tooling.
