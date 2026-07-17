# This rc file is intentionally self-contained. Importing startup files from
# the persistent terminal home or base image can replace or terminate the
# shell before tmux makes its session available.
set +o errexit
set +o nounset
set +o pipefail
unset PROMPT_COMMAND
PS1='\u@\h:\w\$ '
