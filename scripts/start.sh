#!/usr/bin/env bash

set -Eeuo pipefail

readonly APP_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly TERMINAL_WORKDIR_VALUE="${TERMINAL_WORKDIR:-/code}"
readonly TERMINAL_HOME_VALUE="${TERMINAL_HOME:-$TERMINAL_WORKDIR_VALUE}"
readonly XDG_CONFIG_HOME_VALUE="$TERMINAL_HOME_VALUE/.config"
readonly XDG_DATA_HOME_VALUE="$TERMINAL_HOME_VALUE/.local/share"
readonly XDG_CACHE_HOME_VALUE="$TERMINAL_HOME_VALUE/.cache"
readonly TERMINAL_PATH="$APP_ROOT/node_modules/.bin:$TERMINAL_HOME_VALUE/.local/bin:${PATH:-/usr/local/bin:/usr/bin:/bin}"

require_absolute_path() {
  local name="$1"
  local value="$2"

  if [[ "$value" != /* ]]; then
    printf '%s must be an absolute path, received: %s\n' "$name" "$value" >&2
    exit 1
  fi
}

run_in_terminal_environment() {
  env \
    -u AUTH_EMAIL \
    -u AUTH_PASSWORD \
    -u SESSION_SECRET \
    "HOME=$TERMINAL_HOME_VALUE" \
    "XDG_CONFIG_HOME=$XDG_CONFIG_HOME_VALUE" \
    "XDG_DATA_HOME=$XDG_DATA_HOME_VALUE" \
    "XDG_CACHE_HOME=$XDG_CACHE_HOME_VALUE" \
    "PATH=$TERMINAL_PATH" \
    "EDITOR=${EDITOR:-micro}" \
    "VISUAL=${VISUAL:-micro}" \
    "OPENCODE_DISABLE_AUTOUPDATE=1" \
    "AGENT_BROWSER_CONTENT_BOUNDARIES=1" \
    "$@"
}

sync_dotfiles() {
  local source_path
  source_path="$(run_in_terminal_environment chezmoi source-path)"

  if [[ -d "$source_path/.git" ]]; then
    if ! run_in_terminal_environment chezmoi update; then
      printf 'Warning: chezmoi update failed; applying existing local state.\n' >&2
      run_in_terminal_environment chezmoi apply
    fi
    return
  fi

  if [[ -e "$source_path" ]]; then
    printf 'Chezmoi source path exists but is not a Git checkout: %s\n' "$source_path" >&2
    exit 1
  fi

  run_in_terminal_environment chezmoi init --apply \
    https://github.com/kaufmann-dev/dotfiles.git
}

stop_processes() {
  kill "$ttyd_pid" "$app_pid" 2>/dev/null || true
}

require_absolute_path TERMINAL_WORKDIR "$TERMINAL_WORKDIR_VALUE"
require_absolute_path TERMINAL_HOME "$TERMINAL_HOME_VALUE"
mkdir -p \
  "$TERMINAL_WORKDIR_VALUE" \
  "$TERMINAL_HOME_VALUE" \
  "$XDG_CONFIG_HOME_VALUE" \
  "$XDG_DATA_HOME_VALUE" \
  "$XDG_CACHE_HOME_VALUE"

sync_dotfiles

run_in_terminal_environment \
  ttyd \
  --interface 127.0.0.1 \
  --port 7681 \
  --base-path /ttyd \
  --cwd "$TERMINAL_WORKDIR_VALUE" \
  --writable \
  /bin/bash --rcfile "$APP_ROOT/scripts/terminal.bashrc" -i &
ttyd_pid=$!

(
  cd "$APP_ROOT"
  exec node app.js
) &
app_pid=$!

trap stop_processes INT TERM EXIT
set +e
wait -n "$ttyd_pid" "$app_pid"
exit_status=$?
set -e

stop_processes
wait "$ttyd_pid" 2>/dev/null || true
wait "$app_pid" 2>/dev/null || true
trap - EXIT
exit "$exit_status"
