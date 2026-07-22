# Nix-linked GUI cannot load X11 libraries

- Fixed: 2026-07-22 12:17:12 UTC (+0000)
- Pre-fix commit: `0c5939930cc37a8b5143cc8b9ba5293f51e8486a`

## Symptom

A Rust GUI built inside the web terminal failed before creating an X11 window even after Ubuntu's
`xvfb` package was installed. Winit reported that `libX11.so.6` could not be opened. Adding
Ubuntu's multiarch library directory to `LD_LIBRARY_PATH` made the process mix Ubuntu libraries
with the Nix glibc loader and abort with stack-smashing detection.

Rebuilding the same application with Ubuntu's loader allowed it to create its X11 window and use
Mesa's Vulkan software device, proving that the application itself was not the source of the
failure.

## Confirmed Root Cause

Nixpacks installed GCC through Nix, so Rust binaries built in the terminal embedded the Nix glibc
loader. Xvfb and its runtime libraries came from Ubuntu Apt packages under multiarch library paths.
Libraries opened dynamically by Winit and wgpu were not link-time dependencies and therefore had
no Nix runtime path embedded in the executable. The terminal image did not configure `nixLibs` to
make ABI-compatible Nix X11, Vulkan, and Mesa libraries discoverable.

Installing only `xvfb` and `xdotool` provided the required test commands but did not bridge that
runtime-library boundary.

## Changes

- Kept Ubuntu `xvfb` and `xdotool` as the virtual-display and automation commands available after
  deployment.
- Added the X11 libraries used by Winit, the Vulkan loader, and Mesa drivers through Nixpacks
  `nixLibs`, which generates the matching Nix `LD_LIBRARY_PATH` at image startup.
- Installed Mesa's driver output in the Nix profile and exposed its GL driver and Vulkan manifest
  locations through stable `/root/.nix-profile` paths without embedding Nix store hashes.
- Added regression checks for the Nix packages, libraries, stable runtime paths, and their
  preservation in managed PTY environments.
- Documented the GUI test tools, runtime-library design, and troubleshooting guidance.

## Verification

All 29 Node tests pass and the production dependency audit reports no vulnerabilities. Nixpacks
plan generation and build-context generation both succeed, and the generated Nix expression builds
`LD_LIBRARY_PATH` from the requested Nix X11, Vulkan, and Mesa derivations. Nested Podman execution
was explicitly skipped because this application container is intentionally not privileged for
nested container runtimes.
