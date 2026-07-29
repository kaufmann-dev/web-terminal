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

disable_mail_spool_creation() {
  local defaults_file="/etc/default/useradd"

  if [[ ! -f "$defaults_file" ]]; then
    return
  fi

  if grep -q '^CREATE_MAIL_SPOOL=' "$defaults_file"; then
    sed -i 's/^CREATE_MAIL_SPOOL=.*/CREATE_MAIL_SPOOL=no/' "$defaults_file"
    return
  fi

  printf '\nCREATE_MAIL_SPOOL=no\n' >> "$defaults_file"
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
  touch "$file"
  cp -- "$filtered_file" "$file"
  chown root:root "$file"
  chmod 0644 "$file"
)

remove_terminal_supplementary_groups() {
  usermod --groups "" "$TERMINAL_USER"
}

main() {
  local command_name podman_major podman_version

  if [[ "$(id -u)" != "0" ]]; then
    printf 'Rootless Podman image setup must run as root.\n' >&2
    exit 1
  fi

  ensure_terminal_group
  disable_mail_spool_creation
  ensure_terminal_user
  remove_terminal_supplementary_groups
  remove_subid_ranges /etc/subuid
  remove_subid_ranges /etc/subgid

  install -D -o root -g root -m 0644 \
    "$APP_ROOT/config/containers/containers.conf" \
    /etc/containers/web-terminal-containers.conf
  install -D -o root -g root -m 0644 \
    "$APP_ROOT/config/containers/mounts.conf" \
    /etc/containers/mounts.conf
  install -D -o root -g root -m 0644 \
    "$APP_ROOT/config/containers/storage.conf" \
    /etc/containers/web-terminal-storage.conf

  for command_name in podman pasta conmon crun fuse-overlayfs setpriv unshare; do
    if ! command -v "$command_name" >/dev/null; then
      printf 'Required rootless Podman command is missing: %s\n' "$command_name" >&2
      exit 1
    fi
  done
  for command_name in \
    /usr/libexec/podman/netavark \
    /usr/libexec/podman/aardvark-dns; do
    if [[ ! -x "$command_name" ]]; then
      printf 'Required rootless Podman helper is missing: %s\n' "$command_name" >&2
      exit 1
    fi
  done
  if command -v slirp4netns >/dev/null; then
    printf 'slirp4netns must not be installed; Podman 6 uses pasta.\n' >&2
    exit 1
  fi
  if ! podman_version="$(podman --version)"; then
    printf 'Unable to determine the installed Podman version.\n' >&2
    exit 1
  fi
  podman_version="${podman_version#podman version }"
  podman_major="${podman_version%%.*}"
  if [[ ! "$podman_major" =~ ^[0-9]+$ || "$podman_major" -lt 6 ]]; then
    printf 'Podman 6 or newer is required; found %s.\n' "$podman_version" >&2
    exit 1
  fi
}

main "$@"
