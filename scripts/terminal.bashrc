if [[ -r "$HOME/.bashrc" ]]; then
  source "$HOME/.bashrc"
fi

unset PROMPT_DIRTRIM
PS1='\u:\w\$ '
