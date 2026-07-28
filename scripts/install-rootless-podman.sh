#!/usr/bin/env bash

set -Eeuo pipefail

readonly APP_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly TERMINAL_USER="terminal"
readonly TERMINAL_GROUP="terminal"
readonly TERMINAL_UID="1000"
readonly TERMINAL_GID="1000"

ADOPTED_USER=""

ensure_terminal_group() {
  local group_by_name group_by_id user_by_id
  group_by_name="$(getent group "$TERMINAL_GROUP" || true)"
  group_by_id="$(getent group "$TERMINAL_GID" || true)"
  user_by_id="$(getent passwd "$TERMINAL_UID" || true)"

  if [[ -n "$group_by_name" \
    && "$(cut -d: -f3 <<< "$group_by_name")" != "$TERMINAL_GID" ]]; then
    printf 'Group %s has GID %s; expected %s.\n' \
      "$TERMINAL_GROUP" "$(cut -d: -f3 <<< "$group_by_name")" \
      "$TERMINAL_GID" >&2
    exit 1
  fi

  if [[ -z "$group_by_id" ]]; then
    groupadd --gid "$TERMINAL_GID" "$TERMINAL_GROUP"
    return
  fi

  if [[ "${group_by_id%%:*}" == "$TERMINAL_GROUP" ]]; then
    return
  fi

  if [[ -n "$group_by_name" || -z "$user_by_id" \
    || "$(cut -d: -f4 <<< "$user_by_id")" != "$TERMINAL_GID" ]]; then
    printf 'GID %s is assigned to a group that cannot be adopted safely: %s\n' \
      "$TERMINAL_GID" "$group_by_id" >&2
    exit 1
  fi

  groupmod --new-name "$TERMINAL_GROUP" "${group_by_id%%:*}"
}

ensure_terminal_user() {
  local user_by_name user_by_id
  user_by_name="$(getent passwd "$TERMINAL_USER" || true)"
  user_by_id="$(getent passwd "$TERMINAL_UID" || true)"

  if [[ -n "$user_by_name" \
    && "$(cut -d: -f3 <<< "$user_by_name")" != "$TERMINAL_UID" ]]; then
    printf 'User %s has UID %s; expected %s.\n' \
      "$TERMINAL_USER" "$(cut -d: -f3 <<< "$user_by_name")" \
      "$TERMINAL_UID" >&2
    exit 1
  fi

  if [[ -z "$user_by_id" ]]; then
    useradd \
      --uid "$TERMINAL_UID" \
      --gid "$TERMINAL_GID" \
      --home-dir /code \
      --no-create-home \
      --shell /bin/bash \
      "$TERMINAL_USER"
    return
  fi

  if [[ "${user_by_id%%:*}" != "$TERMINAL_USER" ]]; then
    if [[ -n "$user_by_name" \
      || "$(cut -d: -f4 <<< "$user_by_id")" != "$TERMINAL_GID" ]]; then
      printf 'UID %s is assigned to a user that cannot be adopted safely: %s\n' \
        "$TERMINAL_UID" "$user_by_id" >&2
      exit 1
    fi

    ADOPTED_USER="${user_by_id%%:*}"
    usermod \
      --login "$TERMINAL_USER" \
      --gid "$TERMINAL_GID" \
      --home /code \
      --shell /bin/bash \
      "$ADOPTED_USER"
    return
  fi

  if [[ "$(id -g "$TERMINAL_USER")" != "$TERMINAL_GID" ]]; then
    usermod --gid "$TERMINAL_GID" "$TERMINAL_USER"
  fi
  if [[ "$(getent passwd "$TERMINAL_USER" | cut -d: -f6)" != "/code" \
    || "$(getent passwd "$TERMINAL_USER" | cut -d: -f7)" != "/bin/bash" ]]; then
    usermod --home /code --shell /bin/bash "$TERMINAL_USER"
  fi
}

remove_subid_ranges() (
  local file="$1"
  local work_dir filtered_file
  work_dir="$(mktemp -d)"
  filtered_file="$work_dir/$(basename "$file")"
  trap 'rm -rf -- "$work_dir"' EXIT

  if [[ -f "$file" ]]; then
    awk -F: \
      -v user="$TERMINAL_USER" \
      -v adopted_user="$ADOPTED_USER" \
      '$1 != user && (adopted_user == "" || $1 != adopted_user)' \
      "$file" > "$filtered_file"
  else
    : > "$filtered_file"
  fi
  install -o root -g root -m 0644 "$filtered_file" "$file"
)

remove_terminal_supplementary_groups() {
  usermod --groups "" "$TERMINAL_USER"
}

main() {
  if [[ "$(id -u)" != "0" ]]; then
    printf 'Rootless Podman image setup must run as root.\n' >&2
    exit 1
  fi

  ensure_terminal_group
  ensure_terminal_user
  remove_terminal_supplementary_groups
  remove_subid_ranges /etc/subuid
  remove_subid_ranges /etc/subgid

  install -D -o root -g root -m 0644 \
    "$APP_ROOT/config/containers/containers.conf" \
    /etc/containers/web-terminal-containers.conf
  install -D -o root -g root -m 0644 \
    "$APP_ROOT/config/containers/storage.conf" \
    /etc/containers/web-terminal-storage.conf

  for command_name in podman newuidmap newgidmap fuse-overlayfs pasta setpriv unshare; do
    if ! command -v "$command_name" >/dev/null; then
      printf 'Required rootless Podman command is missing: %s\n' "$command_name" >&2
      exit 1
    fi
  done
}

main "$@"
