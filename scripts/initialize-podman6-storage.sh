#!/usr/bin/env bash

set -Eeuo pipefail

if [[ "$#" != "4" ]]; then
  printf 'Usage: %s TERMINAL_HOME XDG_CONFIG_HOME XDG_DATA_HOME XDG_RUNTIME_DIR\n' \
    "${0##*/}" >&2
  exit 2
fi

readonly TERMINAL_HOME_VALUE="$1"
readonly XDG_CONFIG_HOME_VALUE="$2"
readonly XDG_DATA_HOME_VALUE="$3"
readonly XDG_RUNTIME_DIR_VALUE="$4"
readonly WEB_TERMINAL_STATE_DIR="$TERMINAL_HOME_VALUE/.local/state/web-terminal"
readonly PODMAN_STORAGE_RESET_MARKER="$WEB_TERMINAL_STATE_DIR/podman6-storage-reset-v1"
readonly PODMAN_STORAGE_RESET_IN_PROGRESS="$PODMAN_STORAGE_RESET_MARKER.in-progress"
readonly PODMAN_STORAGE_ROOT="$XDG_DATA_HOME_VALUE/containers/storage"
readonly PODMAN_RUN_ROOT="$XDG_RUNTIME_DIR_VALUE/containers"
readonly PODMAN_LEGACY_CNI_ROOT="$XDG_CONFIG_HOME_VALUE/cni"

require_absolute_path() {
  local name="$1"
  local value="$2"

  if [[ "$value" != /* ]]; then
    printf '%s must be an absolute path, received: %s\n' "$name" "$value" >&2
    exit 1
  fi
}

require_descendant_path() {
  local ancestor_path="$1"
  local descendant_path="$2"
  local resolved_ancestor resolved_descendant

  resolved_ancestor="$(realpath -m -- "$ancestor_path")"
  resolved_descendant="$(realpath -m -- "$descendant_path")"
  if [[ "$resolved_descendant" == "$resolved_ancestor" \
    || "$resolved_descendant" != "$resolved_ancestor/"* ]]; then
    printf 'Refusing unsafe Podman reset path outside %s: %s\n' \
      "$resolved_ancestor" "$resolved_descendant" >&2
    exit 1
  fi
}

remove_podman_state_path() {
  local state_path="$1"

  if [[ ! -e "$state_path" && ! -L "$state_path" ]]; then
    return
  fi
  if ! find "$state_path" -xdev -type d -exec chmod u+rwx {} +; then
    printf 'Unable to make legacy Podman state removable: %s\n' "$state_path" >&2
    exit 1
  fi
  if ! find "$state_path" -xdev -depth -delete; then
    printf 'Unable to remove legacy Podman state: %s\n' "$state_path" >&2
    exit 1
  fi
}

main() {
  require_absolute_path TERMINAL_HOME "$TERMINAL_HOME_VALUE"
  require_absolute_path XDG_CONFIG_HOME "$XDG_CONFIG_HOME_VALUE"
  require_absolute_path XDG_DATA_HOME "$XDG_DATA_HOME_VALUE"
  require_absolute_path XDG_RUNTIME_DIR "$XDG_RUNTIME_DIR_VALUE"

  if [[ -f "$PODMAN_STORAGE_RESET_MARKER" \
    && ! -e "$PODMAN_STORAGE_ROOT/libpod/bolt_state.db" ]]; then
    return
  fi

  require_descendant_path "$TERMINAL_HOME_VALUE" "$WEB_TERMINAL_STATE_DIR"
  require_descendant_path "$TERMINAL_HOME_VALUE" "$PODMAN_STORAGE_ROOT"
  require_descendant_path "$TERMINAL_HOME_VALUE" "$PODMAN_LEGACY_CNI_ROOT"
  require_descendant_path "$XDG_RUNTIME_DIR_VALUE" "$PODMAN_RUN_ROOT"

  if [[ -L "$PODMAN_STORAGE_RESET_IN_PROGRESS" ]]; then
    printf 'Refusing symbolic-link Podman reset marker: %s\n' \
      "$PODMAN_STORAGE_RESET_IN_PROGRESS" >&2
    exit 1
  fi

  install -d -m 0755 "$WEB_TERMINAL_STATE_DIR"
  install -m 0644 /dev/null "$PODMAN_STORAGE_RESET_IN_PROGRESS"
  printf 'Initializing clean Podman 6 storage; legacy containers, images, volumes, and networks will be removed.\n'

  remove_podman_state_path "$PODMAN_RUN_ROOT"
  remove_podman_state_path "$PODMAN_LEGACY_CNI_ROOT"
  remove_podman_state_path "$PODMAN_STORAGE_ROOT"

  mv -- "$PODMAN_STORAGE_RESET_IN_PROGRESS" "$PODMAN_STORAGE_RESET_MARKER"
}

main "$@"
