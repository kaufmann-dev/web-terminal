if [[ -r /etc/bash.bashrc ]]; then
  source /etc/bash.bashrc
elif [[ -r /etc/bash_completion ]]; then
  source /etc/bash_completion
fi

if [[ -r "$HOME/.bashrc" ]]; then
  source "$HOME/.bashrc"
fi

_web_terminal_clear_codex_state() {
  if [[ -n "${TMUX:-}" ]]; then
    tmux set-option -pu @web-terminal-command 2>/dev/null || true
    tmux set-option -pu @web-terminal-codex-transcript 2>/dev/null || true
  fi
}

unalias codex 2>/dev/null || true
codex() {
  local codex_status

  if [[ -n "${TMUX:-}" ]]; then
    tmux set-option -p @web-terminal-command codex
    tmux set-option -p @web-terminal-codex-transcript 0
  fi

  command codex "$@"
  codex_status=$?
  _web_terminal_clear_codex_state
  return "$codex_status"
}
