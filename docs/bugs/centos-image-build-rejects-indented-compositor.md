# CentOS Image Build Rejects Indented Compositor Setting

- Fixed: 2026-07-29 16:03:24 UTC (+0000)
- Pre-fix commit: `106ba4843c20cfb074f22d5760651906f1195590`

## Symptom

The Coolify Dockerfile build installed every CentOS and EPEL package successfully, then the same
layer exited with status 1 before any later image step ran. BuildKit attributed the failure to the
combined package-installation `RUN` instruction without identifying which post-install command
failed.

## Confirmed Root Cause

The current CentOS Stream 10 `xwayland-run-0.0.4-5.el10` package writes its compositor setting as
an indented INI entry:

```ini
    Compositor = mutter
```

The Dockerfile's `sed` expression only matched `Compositor` at the first column. It therefore
returned success without changing the file, after which the exact validation for
`Compositor = cage` returned status 1 and failed the layer. The completed DNF transaction, Podman
6 packages, and BuildKit's secret-in-build-argument warnings were unrelated to the failure.

## Changes

- Match optional leading and intra-key whitespace when changing the packaged compositor setting.
- Validate the resulting default INI value with Python's configuration parser, matching
  `xwayland-run` semantics instead of relying on file layout.
- Updated the Dockerfile contract test to require the corrected validation.

## Verification

The corrected replacement and semantic validation were run against the configuration extracted
directly from the current CentOS Stream 10 RPM. It changed the packaged indented default value to
`Compositor = cage`, and the targeted image-contract test passed.
