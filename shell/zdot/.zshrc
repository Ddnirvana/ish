if [[ -n "${ISH_USER_ZDOTDIR:-}" && -r "$ISH_USER_ZDOTDIR/.zshrc" ]]; then
  source "$ISH_USER_ZDOTDIR/.zshrc"
fi
source "$ISH_ROOT/shell/ish.zsh"
