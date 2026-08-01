if [[ -n "${ISH_USER_ZDOTDIR:-}" && -r "$ISH_USER_ZDOTDIR/.zshenv" && "$ISH_USER_ZDOTDIR" != "$ISH_ZDOTDIR" ]]; then
  source "$ISH_USER_ZDOTDIR/.zshenv"
fi
export ZDOTDIR="$ISH_ZDOTDIR"
