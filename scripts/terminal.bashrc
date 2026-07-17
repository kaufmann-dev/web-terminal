if [[ -r /etc/bash.bashrc ]]; then
  source /etc/bash.bashrc
elif [[ -r /etc/bash_completion ]]; then
  source /etc/bash_completion
fi

if [[ -r "$HOME/.bashrc" ]]; then
  source "$HOME/.bashrc"
fi
