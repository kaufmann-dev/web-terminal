# Podman Bridge Network Helper Is Missing

- Fixed: 2026-07-29 15:05:15 UTC (+0000)
- Pre-fix commit: `9f7a65e1c1e40ad61eec82d07b89e02d5c42212f`

## Symptom

Native `podman run` commands used Pasta successfully, but Testcontainers could create an image only
to fail when starting it. Podman's Docker-compatible API reported that `slirp4netns` was missing
when the client explicitly requested `NetworkMode=bridge`.

Installing `slirp4netns` would have made the old image work, but it would have retained the obsolete
Podman 4.9 networking path that the application was intended to replace.

## Confirmed Root Cause

The Ubuntu 24.04 image supplied Podman 4.9. Its managed
`default_rootless_network_cmd = "pasta"` setting affected native rootless containers that used the
default network, but it did not change Podman 4.9's separate rootless CNI implementation for an
explicit bridge request. That implementation was hard-wired to create its outer rootless network
namespace with `slirp4netns`.

Testcontainers sends an explicit bridge network request through Podman's Docker-compatible API.
Consequently, Pasta was present and correctly configured while this distinct Podman 4.9 bridge path
still failed. No containers.conf option could make that old bridge implementation use Pasta.

The failed bridge initialization could also leave a partial namespace in the ephemeral
`XDG_RUNTIME_DIR`, causing a misleading mount error on the next attempt. A fresh runtime directory
removed that secondary symptom but did not fix the missing bridge helper.

## Changes

- Replaced the Ubuntu 24.04/Nixpacks deployment image with a CentOS Stream 10 Dockerfile and changed
  the required Coolify build pack to Dockerfile.
- Installed the maintained Podman 6-or-newer stack natively with DNF: Netavark, Aardvark DNS,
  Pasta, rootlessport, conmon, crun, and fuse-overlayfs. `slirp4netns` is neither installed nor
  accepted by startup validation.
- Configured SQLite state, Netavark networking, Pasta as the outer rootless network command, and
  rootlessport for bridge port publishing. Netavark/Aardvark now handle bridge networking and DNS
  for native and Docker-compatible explicit bridge requests.
- Overrode CentOS's automatic RHEL subscription mounts with an empty managed `mounts.conf`. The
  implicit `/usr/share/rhel/secrets` bind mount failed under the deliberate single-UID storage
  model; explicit Podman secrets are unaffected.
- Added startup checks for Podman 6 or newer and each selected database, network, forwarding, and
  helper implementation.
- Added a one-time, interruption-safe storage reset before `podman info`. It removes the legacy
  graph root, runtime root, and CNI configuration—including old containers, images, volumes, and
  custom networks—while retaining registry credentials and unrelated terminal files. Every
  deletion target is constrained below the expected terminal or runtime root, and a completion
  marker prevents later Podman 6 state from being reset.
- Added regression coverage for the CentOS Dockerfile, the absence of Nix and `slirp4netns`, the
  Podman 6 configuration, reset safety and idempotence, and reset-before-inspection order.
