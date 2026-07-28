#!/usr/bin/env bash

set -Eeuo pipefail

readonly NIXPACKS_VERSION="1.41.0"
readonly NIXPACKS_BASE_URL="https://github.com/railwayapp/nixpacks/releases/download/v${NIXPACKS_VERSION}"

archive_name() {
  case "$1" in
    x86_64 | amd64)
      printf 'nixpacks-v%s-x86_64-unknown-linux-musl.tar.gz\n' "$NIXPACKS_VERSION"
      ;;
    aarch64 | arm64)
      printf 'nixpacks-v%s-aarch64-unknown-linux-musl.tar.gz\n' "$NIXPACKS_VERSION"
      ;;
    *)
      printf 'Unsupported Nixpacks architecture: %s\n' "$1" >&2
      return 1
      ;;
  esac
}

archive_checksum() {
  case "$1" in
    x86_64 | amd64)
      printf '0f55de7874507b9cf7502113120bd96f2ab6979f78d10eaf2eb2ade9207b3af6\n'
      ;;
    aarch64 | arm64)
      printf '912bd02dd2bb6f9c3a9ed965fe8a68b4aa318dc7a2546e2eca6f2806a894ba39\n'
      ;;
    *)
      printf 'Unsupported Nixpacks architecture: %s\n' "$1" >&2
      return 1
      ;;
  esac
}

main() (
  local machine_arch archive checksum work_dir
  machine_arch="$(uname -m)"
  archive="$(archive_name "$machine_arch")"
  checksum="$(archive_checksum "$machine_arch")"
  work_dir="$(mktemp -d)"
  trap 'rm -rf -- "$work_dir"' EXIT

  cd "$work_dir"
  curl --fail --location --silent --show-error --retry 3 \
    --output "$archive" "$NIXPACKS_BASE_URL/$archive"
  printf '%s  %s\n' "$checksum" "$archive" |
    sha256sum --check --strict
  tar --extract --gzip --file "$archive"
  install -D -m 0755 nixpacks /usr/local/bin/nixpacks
)

main "$@"
