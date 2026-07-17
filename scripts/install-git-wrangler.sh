#!/usr/bin/env bash

set -Eeuo pipefail

readonly GIT_WRANGLER_VERSION="0.12.0"
readonly GIT_WRANGLER_BASE_URL="https://github.com/kaufmann-dev/git-wrangler/releases/download/v${GIT_WRANGLER_VERSION}"

map_arch() {
  case "$1" in
    x86_64 | amd64)
      printf 'amd64\n'
      ;;
    aarch64 | arm64)
      printf 'arm64\n'
      ;;
    *)
      printf 'Unsupported Git Wrangler architecture: %s\n' "$1" >&2
      return 1
      ;;
  esac
}

archive_name() {
  printf 'git-wrangler_%s_linux_%s.tar.gz\n' "$GIT_WRANGLER_VERSION" "$(map_arch "$1")"
}

main() (
  local machine_arch archive work_dir checksum_count
  machine_arch="$(uname -m)"
  archive="$(archive_name "$machine_arch")"
  work_dir="$(mktemp -d)"
  trap 'rm -rf -- "$work_dir"' EXIT

  cd "$work_dir"
  curl --fail --location --silent --show-error --retry 3 \
    --output "$archive" "$GIT_WRANGLER_BASE_URL/$archive"
  curl --fail --location --silent --show-error --retry 3 \
    --output checksums.txt "$GIT_WRANGLER_BASE_URL/checksums.txt"

  checksum_count="$(awk -v archive="$archive" '$2 == archive { count++ } END { print count + 0 }' checksums.txt)"
  if [[ "$checksum_count" != "1" ]]; then
    printf 'Expected one checksum for %s, found %s\n' "$archive" "$checksum_count" >&2
    exit 1
  fi

  awk -v archive="$archive" '$2 == archive { print }' checksums.txt |
    sha256sum --check --strict
  tar --extract --gzip --file "$archive"

  install -D -m 0755 git-wrangler /usr/local/bin/git-wrangler
  install -D -m 0644 completions/git-wrangler.bash \
    /usr/share/bash-completion/completions/git-wrangler
)

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
