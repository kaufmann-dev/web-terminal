#!/usr/bin/env bash

set -euo pipefail

session_name="${1:-}"

if [[ "$#" -ne 1 ]]; then
  printf 'Invalid terminal session name: expected one argument, received %d.\n' "$#" >&2
  exit 64
fi

if [[ ! "$session_name" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]]; then
  printf 'Invalid terminal session name: received %d characters.\n' "${#session_name}" >&2
  exit 64
fi

exec tmux -L web-terminal attach-session -t "=$session_name"
