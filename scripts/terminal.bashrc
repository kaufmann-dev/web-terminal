# Managed sessions must not source persistent user startup files: they can
# replace or terminate the shell before tmux makes the session available.
if [[ -r /etc/bash.bashrc ]]; then
  source /etc/bash.bashrc
elif [[ -r /etc/bash_completion ]]; then
  source /etc/bash_completion
fi
