if [[ -n "${ISH_USER_ZDOTDIR:-}" && -r "$ISH_USER_ZDOTDIR/.zprofile" ]]; then
  source "$ISH_USER_ZDOTDIR/.zprofile"
fi
