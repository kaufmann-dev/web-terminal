#!/usr/bin/env bash

set -Eeuo pipefail

readonly MUSE_VERSION="1.1.1-R2514.1"
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
      printf '47908f2e5b0ac5b0c0ba147a48b30a9e48c0aebea3c5cc891ad34d95425a4993\n'
      ;;
    aarch64 | arm64)
      printf '8836ca0f525f4d2bfd22e6891dbafa081dbdaa42bff71d090d85ad7ec8465d44\n'
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
