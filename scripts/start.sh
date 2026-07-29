#!/usr/bin/env bash

set -Eeuo pipefail

readonly APP_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly TERMINAL_WORKDIR_VALUE="${TERMINAL_WORKDIR:-/code}"
readonly TERMINAL_HOME_VALUE="${TERMINAL_HOME:-$TERMINAL_WORKDIR_VALUE}"
readonly XDG_CONFIG_HOME_VALUE="$TERMINAL_HOME_VALUE/.config"
readonly XDG_DATA_HOME_VALUE="$TERMINAL_HOME_VALUE/.local/share"
readonly XDG_CACHE_HOME_VALUE="$TERMINAL_HOME_VALUE/.cache"
readonly TERMINAL_USER="terminal"
readonly TERMINAL_GROUP="terminal"
readonly TERMINAL_UID="1000"
readonly TERMINAL_GID="1000"
readonly RUNTIME_UID="$([[ "$(id -u)" == "0" ]] && printf '%s' "$TERMINAL_UID" || id -u)"
readonly XDG_RUNTIME_DIR_VALUE="/tmp/web-terminal-runtime-$RUNTIME_UID"
readonly REGISTRY_AUTH_FILE_VALUE="$XDG_CONFIG_HOME_VALUE/containers/auth.json"
readonly TERMINAL_PATH="$APP_ROOT/node_modules/.bin:$TERMINAL_HOME_VALUE/.local/bin:/usr/local/bin:${PATH:-/usr/bin:/bin}"
readonly WEB_TERMINAL_STATE_DIR="$TERMINAL_HOME_VALUE/.local/state/web-terminal"
readonly OWNERSHIP_MIGRATION_MARKER="$WEB_TERMINAL_STATE_DIR/uid-1000-v1"
readonly PODMAN_CONTAINERS_CONF="/etc/containers/web-terminal-containers.conf"
readonly PODMAN_MOUNTS_CONF="/etc/containers/mounts.conf"
readonly PODMAN_STORAGE_CONF="/etc/containers/web-terminal-storage.conf"

require_absolute_path() {
  local name="$1"
  local value="$2"

  if [[ "$value" != /* ]]; then
    printf '%s must be an absolute path, received: %s\n' "$name" "$value" >&2
    exit 1
  fi
}

run_in_terminal_environment() {
  local -a unset_environment=(-u SESSION_SECRET)
  local -a podman_environment=()
  local -a terminal_identity_environment=()
  local environment_name

  while IFS= read -r environment_name; do
    if [[ "$environment_name" == OIDC_* ]]; then
      unset_environment+=(-u "$environment_name")
    fi
  done < <(compgen -e)

  if is_container_environment; then
    terminal_identity_environment=(
      "USER=$TERMINAL_USER"
      "LOGNAME=$TERMINAL_USER"
      "SHELL=/bin/bash"
    )
    podman_environment=(
      "BUILDAH_ISOLATION=chroot"
      "_CONTAINERS_USERNS_CONFIGURED="
      "CONTAINERS_CONF=$PODMAN_CONTAINERS_CONF"
      "CONTAINERS_STORAGE_CONF=$PODMAN_STORAGE_CONF"
    )
  fi

  run_as_terminal env \
    "${unset_environment[@]}" \
    "HOME=$TERMINAL_HOME_VALUE" \
    "XDG_CONFIG_HOME=$XDG_CONFIG_HOME_VALUE" \
    "XDG_DATA_HOME=$XDG_DATA_HOME_VALUE" \
    "XDG_CACHE_HOME=$XDG_CACHE_HOME_VALUE" \
    "XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR_VALUE" \
    "REGISTRY_AUTH_FILE=$REGISTRY_AUTH_FILE_VALUE" \
    "PATH=$TERMINAL_PATH" \
    "${terminal_identity_environment[@]}" \
    "EDITOR=${EDITOR:-micro}" \
    "VISUAL=${VISUAL:-micro}" \
    "OPENCODE_DISABLE_AUTOUPDATE=1" \
    "AGENT_BROWSER_CONTENT_BOUNDARIES=1" \
    "${podman_environment[@]}" \
    "$@"
}

is_container_environment() {
  [[ -f /.dockerenv || -f /run/.containerenv ]]
}

configure_rootless_podman_environment() {
  if ! is_container_environment; then
    return
  fi

  export BUILDAH_ISOLATION=chroot
  export _CONTAINERS_USERNS_CONFIGURED=
  export CONTAINERS_CONF="$PODMAN_CONTAINERS_CONF"
  export CONTAINERS_STORAGE_CONF="$PODMAN_STORAGE_CONF"
}

run_as_terminal() {
  if ! is_container_environment || [[ "$(id -u)" != "0" ]]; then
    "$@"
    return
  fi

  setpriv \
    --reuid="$TERMINAL_UID" \
    --regid="$TERMINAL_GID" \
    --init-groups \
    "$@"
}

run_chezmoi() {
  # Container startup has no controlling TTY. The persistent terminal home can
  # contain files previously managed by chezmoi, so apply its desired state
  # without waiting for an overwrite prompt.
  run_in_terminal_environment chezmoi --force --no-tty "$@"
}

sync_dotfiles() {
  local source_path
  source_path="$(run_chezmoi source-path)"

  if [[ -d "$source_path/.git" ]]; then
    if ! run_chezmoi update; then
      printf 'Warning: chezmoi update failed; applying existing local state.\n' >&2
      run_chezmoi apply
    fi
    return
  fi

  if [[ -e "$source_path" ]]; then
    printf 'Chezmoi source path exists but is not a Git checkout: %s\n' "$source_path" >&2
    exit 1
  fi

  run_chezmoi init --apply \
    https://github.com/kaufmann-dev/dotfiles.git
}

ownership_migration_is_current() {
  local -a migrated_paths=()

  [[ -f "$OWNERSHIP_MIGRATION_MARKER" ]] || return 1
  mapfile -t migrated_paths < "$OWNERSHIP_MIGRATION_MARKER"
  [[ "${#migrated_paths[@]}" == "2" \
    && "${migrated_paths[0]}" == "$TERMINAL_WORKDIR_VALUE" \
    && "${migrated_paths[1]}" == "$TERMINAL_HOME_VALUE" ]]
}

migrate_terminal_ownership() {
  if ! is_container_environment || [[ "$(id -u)" != "0" ]] \
    || ownership_migration_is_current; then
    return
  fi

  printf 'Migrating terminal paths to UID/GID %s:%s.\n' "$TERMINAL_UID" "$TERMINAL_GID"
  chown --recursive --no-dereference \
    "$TERMINAL_USER:$TERMINAL_GROUP" \
    -- "$TERMINAL_WORKDIR_VALUE"
  if [[ "$TERMINAL_HOME_VALUE" != "$TERMINAL_WORKDIR_VALUE" ]]; then
    chown --recursive --no-dereference \
      "$TERMINAL_USER:$TERMINAL_GROUP" \
      -- "$TERMINAL_HOME_VALUE"
  fi

  install -d -o "$TERMINAL_USER" -g "$TERMINAL_GROUP" -m 0755 \
    "$(dirname -- "$OWNERSHIP_MIGRATION_MARKER")"
  printf '%s\n%s\n' "$TERMINAL_WORKDIR_VALUE" "$TERMINAL_HOME_VALUE" \
    > "$OWNERSHIP_MIGRATION_MARKER"
  chown "$TERMINAL_USER:$TERMINAL_GROUP" "$OWNERSHIP_MIGRATION_MARKER"
}

initialize_clean_podman6_storage() {
  if ! bash "$APP_ROOT/scripts/initialize-podman6-storage.sh" \
    "$TERMINAL_HOME_VALUE" \
    "$XDG_CONFIG_HOME_VALUE" \
    "$XDG_DATA_HOME_VALUE" \
    "$XDG_RUNTIME_DIR_VALUE"; then
    printf 'Unable to initialize clean Podman 6 storage.\n' >&2
    exit 1
  fi
}

validate_rootless_podman() {
  local aardvark_executable command_name database_backend host_info
  local netavark_executable network_backend pasta_executable podman_major
  local podman_version proc_mount_check_path rootless_network_cmd rootless_port_forwarder

  for command_name in podman pasta conmon crun fuse-overlayfs unshare mount umount; do
    if ! command -v "$command_name" >/dev/null; then
      printf 'Required rootless Podman command is missing: %s\n' "$command_name" >&2
      exit 1
    fi
  done
  if command -v slirp4netns >/dev/null; then
    printf 'slirp4netns must not be installed; Podman 6 uses pasta.\n' >&2
    exit 1
  fi

  if [[ ! -f "$PODMAN_CONTAINERS_CONF" || ! -f "$PODMAN_MOUNTS_CONF" \
    || ! -f "$PODMAN_STORAGE_CONF" ]]; then
    printf 'Rootless Podman configuration is missing from /etc/containers.\n' >&2
    exit 1
  fi
  if [[ ! -c /dev/fuse ]]; then
    printf '/dev/fuse is unavailable; configure the Coolify /dev/fuse device mapping.\n' >&2
    exit 1
  fi
  if [[ ! -c /dev/net/tun ]]; then
    printf '/dev/net/tun is unavailable; configure the Coolify /dev/net/tun device mapping.\n' >&2
    exit 1
  fi
  if ! run_as_terminal test -r /dev/fuse || ! run_as_terminal test -w /dev/fuse; then
    printf '/dev/fuse is not readable and writable by the terminal user.\n' >&2
    exit 1
  fi
  if ! run_as_terminal test -r /dev/net/tun || ! run_as_terminal test -w /dev/net/tun; then
    printf '/dev/net/tun is not readable and writable by the terminal user.\n' >&2
    exit 1
  fi
  if ! run_in_terminal_environment unshare --user --map-root-user true; then
    printf 'Rootless user namespaces are blocked; configure the Coolify seccomp and AppArmor options.\n' >&2
    exit 1
  fi
  proc_mount_check_path="$XDG_RUNTIME_DIR_VALUE/podman-proc-mount-check"
  run_as_terminal mkdir -p -- "$proc_mount_check_path"
  if ! run_in_terminal_environment \
    unshare --user --map-root-user \
    unshare --mount --pid --fork \
    bash -c 'mount -t proc proc "$1" && umount "$1"' \
    bash "$proc_mount_check_path"; then
    printf 'Nested proc mounts are blocked; add --security-opt systempaths=unconfined to Coolify Custom Docker Options.\n' >&2
    exit 1
  fi
  run_as_terminal rmdir -- "$proc_mount_check_path"
  if ! podman_version="$(
    run_in_terminal_environment \
      podman --version 2>/dev/null
  )"; then
    printf 'Unable to determine the installed Podman version.\n' >&2
    exit 1
  fi
  podman_version="${podman_version#podman version }"
  podman_major="${podman_version%%.*}"
  if [[ ! "$podman_major" =~ ^[0-9]+$ || "$podman_major" -lt 6 ]]; then
    printf 'Podman 6 or newer is required; found %s.\n' "$podman_version" >&2
    exit 1
  fi

  initialize_clean_podman6_storage

  if ! host_info="$(
    run_in_terminal_environment \
      podman info \
      --format '{{.Host.DatabaseBackend}}|{{.Host.NetworkBackend}}|{{.Host.RootlessNetworkCmd}}|{{.Host.RootlessPortForwarder}}|{{.Host.NetworkBackendInfo.Path}}|{{.Host.NetworkBackendInfo.DNS.Path}}|{{.Host.Pasta.Executable}}' \
      2>/dev/null
  )"; then
    printf 'Rootless Podman failed its startup self-check.\n' >&2
    exit 1
  fi
  IFS='|' read -r \
    database_backend network_backend rootless_network_cmd rootless_port_forwarder \
    netavark_executable aardvark_executable pasta_executable \
    <<< "$host_info"
  if [[ "$database_backend" != "sqlite" ]]; then
    printf 'Rootless Podman must use its SQLite database; found %s.\n' "$database_backend" >&2
    exit 1
  fi
  if [[ "$network_backend" != "netavark" ]]; then
    printf 'Rootless Podman must use the Netavark network backend; found %s.\n' \
      "$network_backend" >&2
    exit 1
  fi
  if [[ "$rootless_network_cmd" != "pasta" ]]; then
    printf 'Rootless Podman must use pasta for rootless networking; found %s.\n' \
      "$rootless_network_cmd" >&2
    exit 1
  fi
  if [[ "$rootless_port_forwarder" != "rootlessport" ]]; then
    printf 'Rootless Podman must use rootlessport for bridge port forwarding; found %s.\n' \
      "$rootless_port_forwarder" >&2
    exit 1
  fi
  if [[ -z "$netavark_executable" || ! -x "$netavark_executable" ]]; then
    printf 'Rootless Podman did not detect an executable Netavark network helper.\n' >&2
    exit 1
  fi
  if [[ -z "$aardvark_executable" || ! -x "$aardvark_executable" ]]; then
    printf 'Rootless Podman did not detect an executable Aardvark DNS helper.\n' >&2
    exit 1
  fi
  if [[ -z "$pasta_executable" || ! -x "$pasta_executable" ]]; then
    printf 'Rootless Podman did not detect an executable pasta network helper.\n' >&2
    exit 1
  fi
}

require_absolute_path TERMINAL_WORKDIR "$TERMINAL_WORKDIR_VALUE"
require_absolute_path TERMINAL_HOME "$TERMINAL_HOME_VALUE"
mkdir -p \
  "$TERMINAL_WORKDIR_VALUE" \
  "$TERMINAL_HOME_VALUE" \
  "$XDG_CONFIG_HOME_VALUE" \
  "$XDG_DATA_HOME_VALUE" \
  "$XDG_CACHE_HOME_VALUE" \
  "$(dirname -- "$REGISTRY_AUTH_FILE_VALUE")" \
  "$XDG_RUNTIME_DIR_VALUE"

if is_container_environment && [[ "$(id -u)" == "0" ]]; then
  if [[ "$(id -u "$TERMINAL_USER" 2>/dev/null || true)" != "$TERMINAL_UID" \
    || "$(id -g "$TERMINAL_USER" 2>/dev/null || true)" != "$TERMINAL_GID" ]]; then
    printf 'The terminal user must exist with UID/GID %s:%s.\n' \
      "$TERMINAL_UID" "$TERMINAL_GID" >&2
    exit 1
  fi
  chown "$TERMINAL_USER:$TERMINAL_GROUP" "$XDG_RUNTIME_DIR_VALUE"
  chmod 0700 "$XDG_RUNTIME_DIR_VALUE"
fi

migrate_terminal_ownership
if is_container_environment; then
  configure_rootless_podman_environment
  validate_rootless_podman
fi
sync_dotfiles

cd "$APP_ROOT"
if is_container_environment && [[ "$(id -u)" == "0" ]]; then
  exec setpriv \
    --reuid="$TERMINAL_UID" \
    --regid="$TERMINAL_GID" \
    --init-groups \
    env \
    "XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR_VALUE" \
    "REGISTRY_AUTH_FILE=$REGISTRY_AUTH_FILE_VALUE" \
    "USER=$TERMINAL_USER" \
    "LOGNAME=$TERMINAL_USER" \
    "SHELL=/bin/bash" \
    node app.js
fi

export XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR_VALUE"
export REGISTRY_AUTH_FILE="$REGISTRY_AUTH_FILE_VALUE"
exec node app.js
