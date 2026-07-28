# Rootless Podman Proc Mount Is Blocked

- Fixed: 2026-07-28 12:50:34 CEST (+0200)
- Pre-fix commit: `6f70f66b926bc861715b0f31107245560fda2e1e`

## Symptom

Rootless Podman pulled the requested image and initialized pasta networking, but crun could not
start the nested container:

```text
Error: crun: mount `proc` to `proc`: Operation not permitted: OCI permission denied
```

## Confirmed Root Cause

The Coolify application already used unconfined seccomp and AppArmor policies. Docker applies a
separate set of masked and read-only system paths to every container, however, and those paths
prevented the nested runtime from creating its own proc mount.

The same production-shaped image and nested Alpine command reproduced the failure without Docker's
system-path option. Adding only `--security-opt systempaths=unconfined` allowed the nested
rootless container to start and complete an outbound HTTP request. Docker handles this option by
clearing the container's OCI masked-path and read-only-path lists.

## Changes

- Added `--security-opt systempaths=unconfined` to the required Coolify Custom Docker Options.
- Added a startup preflight that creates a temporary proc mount in nested user, mount, and PID
  namespaces, then unmounts it before the application starts.
- Added a targeted startup error for missing system-path permissions.
- Added regression coverage for the proc-mount preflight and deployment requirement.
