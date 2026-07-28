# Rootless Podman Subordinate-ID Mapping Is Blocked

- Fixed: 2026-07-28 10:01:05 CEST (+0200)
- Pre-fix commit: `e3c3b26aaa23e0804baad429385063a0699df8f4`

## Symptom

The Coolify application restarted until it reached the restart limit. Each startup failed during
the rootless Podman self-check because `newuidmap` could not write the requested 65,536-entry
subordinate UID mapping:

```text
newuidmap: write to uid_map failed: Operation not permitted
Rootless Podman failed its startup self-check.
```

The configured `/dev/fuse`, unconfined seccomp, and unconfined AppArmor options were already
present.

## Confirmed Root Cause

The image assigned `/etc/subuid` and `/etc/subgid` ranges to the terminal user. Podman therefore
invoked the setuid `newuidmap` and `newgidmap` helpers to create a 65,536-ID user namespace.
Coolify's outer application container allowed an ordinary one-ID user namespace but did not allow
those helpers to install multi-ID maps without granting `SYS_ADMIN`.

Granting `SYS_ADMIN` made the mapping possible in reproduction, but it would substantially expand
the outer container's authority. Podman's supported single-UID mode instead succeeded with one
mapping from nested UID/GID 0 to application UID/GID 1000 and required no additional capability.

## Changes

- Removed subordinate UID/GID ranges for the terminal identity and any adopted Nixpacks identity.
- Enabled `ignore_chown_errors` for fuse-overlayfs so nested image ownership is flattened into the
  one available UID/GID.
- Kept the startup self-check diagnostic while suppressing Podman's expected no-subuid warning
  when the check succeeds.
- Documented single-ID ownership behavior and the compatibility limit for images that require
  distinct persisted owners.
- Added regression assertions for the single-ID installer and storage configuration.

## Verification

- All shell scripts passed `bash -n`.
- All JavaScript syntax checks and 29 Node tests passed.
- Nixpacks 1.41 generated the Node.js 24 deployment plan, and Podman built the generated image.
- The built image reported `rootless=true` with one UID map and one GID map, each mapping nested ID
  0 to application ID 1000 with size 1.
- Nested Podman pulled and unpacked Alpine without `SYS_ADMIN`, confirming the single-ID storage
  path.
