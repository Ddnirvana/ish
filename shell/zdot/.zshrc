if [[ -n "${ISH_USER_ZDOTDIR:-}" && -r "$ISH_USER_ZDOTDIR/.zshrc" ]]; then
  source "$ISH_USER_ZDOTDIR/.zshrc"
fi
if [[ -z "${HISTFILE:-}" || "$HISTFILE" == "$ISH_ZDOTDIR/"* ]]; then
  HISTFILE="$ISH_USER_ZDOTDIR/.zsh_history"
fi
source "$ISH_ROOT/shell/ish.zsh"
