# Rootless Podman Configuration Is Not Inherited

- Fixed: 2026-07-29 13:49:26 UTC (+0000)
- Pre-fix commit: `34d76f62339d352df5ae30c6c4c0fce2aaaaaee4`

## Symptom

An interactive terminal or Codex process could run Podman, but an ordinary networked
`podman run` failed because Podman tried to execute the intentionally absent `slirp4netns`
helper. The image's managed configuration selected the installed `pasta` helper, and the
same command succeeded when that configuration was supplied explicitly.

## Confirmed Root Cause

The startup script passed `CONTAINERS_CONF`, `CONTAINERS_STORAGE_CONF`,
`BUILDAH_ISOLATION`, and `_CONTAINERS_USERNS_CONFIGURED` only when it changed from root
to the terminal user. Coolify starts this image directly as UID 1000, so that branch did
not run. The Node process, its terminal sessions, and Codex therefore inherited none of
the managed Podman environment and Podman 4.9 fell back to its `slirp4netns` default.

The live container already had the required `/dev/fuse` and `/dev/net/tun` mappings,
security options, Podman configuration, and `pasta` executable. Running a networked
container with the managed environment explicitly supplied succeeded, confirming that
no additional Coolify setting or package was required.

## Changes

- Exported the managed rootless Podman environment for every container startup, whether
  the entrypoint begins as root or UID 1000.
- Removed the duplicate Podman assignments from the root-only launch branch.
- Added regression coverage that checks both startup export behavior and terminal
  environment inheritance.
