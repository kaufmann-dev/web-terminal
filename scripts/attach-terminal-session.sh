#!/usr/bin/env bash

set -euo pipefail

session_name="${1:-}"

if [[ "$#" -ne 1 || ! "$session_name" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]]; then
  echo "Invalid terminal session name." >&2
  exit 64
fi

exec tmux -L web-terminal attach-session -t "=$session_name"
