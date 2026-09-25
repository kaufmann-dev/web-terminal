#!/usr/bin/env bash

set -Eeuo pipefail

readonly MUSE_VERSION="1.4.0-R4161.1"
readonly MUSE_BASE_URL="https://lookaside.facebook.com/lookaside/muse/download/?channel=muse&version=${MUSE_VERSION}"

artifact_name() {
  case "$1" in
    x86_64 | amd64)
      printf 'muse-x86-linux\n'
      ;;
    aarch64 | arm64)
      printf 'muse-aarch64-linux\n'
      ;;
    *)
      printf 'Unsupported Muse Code architecture: %s\n' "$1" >&2
      return 1
      ;;
  esac
}

# SHA-256 values published in this release's file=manifest.json.
artifact_checksum() {
  case "$1" in
    x86_64 | amd64)
      printf '1b68bd4518d53a2aaff063915df4d141b0a205e6d79038299d04e3a14e85a5b9\n'
      ;;
    aarch64 | arm64)
      printf '38a0e3b7f59825ffc60f7fae65ac9727cf9bbb47fe4e687cc29cede9deb8fabf\n'
      ;;
    *)
      printf 'Unsupported Muse Code architecture: %s\n' "$1" >&2
      return 1
      ;;
  esac
}

main() (
  local machine_arch artifact checksum work_dir
  machine_arch="$(uname -m)"
  artifact="$(artifact_name "$machine_arch")"
  checksum="$(artifact_checksum "$machine_arch")"
  work_dir="$(mktemp -d)"
  trap 'rm -rf -- "$work_dir"' EXIT

  cd "$work_dir"
  curl --fail --location --silent --show-error --retry 3 \
    --proto '=https' --proto-redir '=https' \
    --output "$artifact" "${MUSE_BASE_URL}&file=${artifact}"
  printf '%s  %s\n' "$checksum" "$artifact" |
    sha256sum --check --strict
  install -D -m 0755 "$artifact" /usr/local/bin/muse
)

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
