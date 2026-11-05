#!/usr/bin/env bash

set -Eeuo pipefail

readonly RAILPACK_VERSION="0.43.0"
readonly RAILPACK_BASE_URL="https://github.com/railwayapp/railpack/releases/download/v${RAILPACK_VERSION}"

archive_name() {
  case "$1" in
    x86_64 | amd64)
      printf 'railpack-v%s-x86_64-unknown-linux-musl.tar.gz\n' "$RAILPACK_VERSION"
      ;;
    aarch64 | arm64)
      printf 'railpack-v%s-arm64-unknown-linux-musl.tar.gz\n' "$RAILPACK_VERSION"
      ;;
    *)
      printf 'Unsupported Railpack architecture: %s\n' "$1" >&2
      return 1
      ;;
  esac
}

archive_checksum() {
  case "$1" in
    x86_64 | amd64)
      printf '248a8f60f36854aabed6124113631078a802de3461660855fc4de9c26065c1fb\n'
      ;;
    aarch64 | arm64)
      printf '732ece14eb4f4676a43ebba19431f954edf7b130acb76159ef0f2ff86ac42ac9\n'
      ;;
    *)
      printf 'Unsupported Railpack architecture: %s\n' "$1" >&2
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
    --output "$archive" "$RAILPACK_BASE_URL/$archive"
  printf '%s  %s\n' "$checksum" "$archive" |
    sha256sum --check --strict
  tar --extract --gzip --file "$archive"
  install -D -m 0755 railpack /usr/local/bin/railpack
)

main "$@"
