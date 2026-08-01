if [[ -n "${ISH_USER_ZDOTDIR:-}" && -r "$ISH_USER_ZDOTDIR/.zlogout" ]]; then
  source "$ISH_USER_ZDOTDIR/.zlogout"
fi
