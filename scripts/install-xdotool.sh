#!/usr/bin/env bash

set -Eeuo pipefail

readonly XDOTOOL_VERSION="4.20260303.1"
readonly XDOTOOL_SHA256="c1f971a384da588eb99ca0755fc4300316d49c1e612537e3f1de52215e104fa3"
readonly XDOTOOL_URL="https://github.com/jordansissel/xdotool/archive/refs/tags/v${XDOTOOL_VERSION}.tar.gz"

main() (
  local archive work_dir

  if [[ "$(id -u)" != "0" ]]; then
    printf 'xdotool image setup must run as root.\n' >&2
    exit 1
  fi

  work_dir="$(mktemp -d)"
  archive="$work_dir/xdotool.tar.gz"
  trap 'rm -rf -- "$work_dir"' EXIT

  curl --fail --location --silent --show-error --retry 3 \
    --output "$archive" "$XDOTOOL_URL"
  printf '%s  %s\n' "$XDOTOOL_SHA256" "$archive" |
    sha256sum --check --strict
  tar --extract --gzip --file "$archive" --directory "$work_dir"

  cd "$work_dir/xdotool-$XDOTOOL_VERSION"
  make --jobs="$(nproc)"
  make \
    PREFIX=/usr/local \
    INSTALLMAN=/usr/local/share/man \
    install

  if [[ "$(xdotool version)" != "xdotool version $XDOTOOL_VERSION" ]]; then
    printf 'Installed xdotool version is not %s.\n' "$XDOTOOL_VERSION" >&2
    exit 1
  fi
)

main "$@"
