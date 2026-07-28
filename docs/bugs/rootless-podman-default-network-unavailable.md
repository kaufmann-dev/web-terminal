# Rootless Podman Default Network Is Unavailable

- Fixed: 2026-07-28 12:22:00 CEST (+0200)
- Pre-fix commit: `5b931290dd8f6df5451a39b10cf45f5545da3a31`

## Symptom

Rootless Podman could pull images, but an ordinary `podman run` using the default network failed
because Podman tried to execute `slirp4netns`, which is intentionally not installed in the image.
Explicitly selecting another network was required even though the `pasta` command was available.

## Confirmed Root Cause

The image installed `passt`, validated the resulting `pasta` command, and retained its configuration
in terminal environments. However, the Podman 4.9 `containers.conf` did not set a default rootless
network command. Podman therefore used its 4.9 default, `slirp4netns`.

Podman 4.9.3 supports selecting pasta with
`[network] default_rootless_network_cmd = "pasta"`. The project already installs that backend, so
adding slirp4netns would create an unnecessary second networking path. Pasta also requires
`/dev/net/tun` in the application container so it can create the nested container's TAP device.

## Changes

- Configured pasta as Podman's default rootless network command.
- Changed the startup self-check to require the pasta configuration, verify Podman detects the
  helper, and validate `/dev/net/tun`.
- Added `/dev/net/tun` to the required Coolify Custom Docker Options.
- Added regression coverage for both the installed configuration and startup validation.
