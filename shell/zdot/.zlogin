if [[ -n "${ISH_USER_ZDOTDIR:-}" && -r "$ISH_USER_ZDOTDIR/.zlogin" ]]; then
  source "$ISH_USER_ZDOTDIR/.zlogin"
fi
