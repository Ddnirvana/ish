# ish shell integration: native zsh remains the primary execution substrate.

_ish_native_fast_path() {
  emulate -L zsh
  setopt extendedglob

  local line="${1##[[:space:]]#}"
  [[ -z "$line" ]] && return 0
  [[ "$line" == \? || "$line" == \?\ * || "$line" == /ask || "$line" == /ask\ * ]] && return 1
  [[ "$line" == /intent* || "$line" == /panes* || "$line" == /capsules* || "$line" == /actions* || "$line" == /observe* || "$line" == /apply* || "$line" == /broadcast* || "$line" == /context* ]] && return 1

  local -a words
  words=(${(z)line}) 2>/dev/null || return 0
  local first="${words[1]:-}"

  [[ "$first" == (.|..|/)/* || "$first" == [A-Za-z_][A-Za-z0-9_]#=* ]] && return 0
  [[ "$line" == *[\|\&\;\<\>\(\)\`\$\\]* ]] && return 0
  (( $+commands[$first] || $+builtins[$first] || $+aliases[$first] || $+functions[$first] || $+reswords[$first] )) && return 0
  return 1
}

typeset -g _ISH_CAPSULE_ID="${_ISH_CAPSULE_ID:-}"
typeset -g _ISH_ACTION_FIFO="${_ISH_ACTION_FIFO:-}"
typeset -gi _ISH_ACTION_FD=${_ISH_ACTION_FD:--1}
typeset -gi _ISH_GENERATION=${_ISH_GENERATION:-0}
typeset -g _ISH_ACTIVE_ACTION=""
typeset -g _ISH_ACTIVE_COMMAND=""
typeset -g _ISH_PENDING_AGENT=""
typeset -g _ISH_PENDING_CONTROL=""
typeset -gi _ISH_RESTORE_HIST_IGNORE_SPACE=0
typeset -g _ISH_TRANSCRIPT_ID=""
typeset -gi _ISH_TRANSCRIPT_SEQ=0
typeset -gA _ISH_SEEN_ACTIONS

_ish_async_ctl() {
  (command ishctl "$@" >/dev/null 2>&1) &!
}

_ish_boot_id() {
  if [[ -r /proc/sys/kernel/random/boot_id ]]; then
    command cat /proc/sys/kernel/random/boot_id
  else
    command sysctl -n kern.boottime 2>/dev/null || print -r -- "host-unknown"
  fi
}

_ish_tmux_field() {
  local format="$1"
  [[ -n "${TMUX:-}" ]] || { print -r -- "-"; return; }
  command tmux display-message -p "$format" 2>/dev/null || print -r -- "-"
}

_ish_risk_candidate() {
  emulate -L zsh
  setopt extendedglob
  local line="${1:l}"
  [[ "$line" == *rm\ * || "$line" == rm\ * ||
     "$line" == *sudo\ * || "$line" == sudo\ * ||
     "$line" == *(mkfs|wipefs|fdisk|cfdisk|sfdisk|parted|shutdown|reboot|poweroff|halt)* ||
     "$line" == *dd\ *of=/dev/* || "$line" == *(curl|wget)*\|*(sh|bash|zsh|python|node)* ||
     "$line" == *git\ *(reset\ --hard|clean\ -*|checkout\ --*|restore\ *--worktree*) ||
     "$line" == *(docker\ system\ prune|kubectl\ delete|terraform\ destroy|drop\ database|drop\ schema|drop\ table)* ||
     "$line" == *(chmod|chown)*(-R|--recursive)* ||
     "$line" == /apply\ *--execute* || "$line" == /broadcast\ *--execute* ]]
}

_ish_confirm_risk() {
  emulate -L zsh
  local line="$1"
  local assessment level rule reason
  assessment="$(command ishctl risk -- "$line" 2>/dev/null)" || assessment=$'critical\tclassifier-unavailable\tish could not verify the operation safely'
  IFS=$'\t' read -r level rule reason <<< "$assessment"
  [[ "$level" == safe || "$level" == caution ]] && return 0

  local width=$(( ${COLUMNS:-80} / 2 ))
  (( width < 20 )) && width=20
  local command_view="$line"
  (( ${#command_view} > width )) && command_view="${command_view[1,$(( width - 3 ))]}..."
  zle -M "! ish approval required [$level/$rule] | $command_view | $reason | y=run once e=edit n=cancel"
  zle -R
  local answer
  read -rk 1 answer
  case "${answer:l}" in
    y)
      zle -M "ish approved once: $rule"
      BUFFER="$line"
      CURSOR=${#BUFFER}
      return 0
      ;;
    e)
      zle -M "ish returned the command for editing; changed text requires approval again"
      BUFFER="$line"
      CURSOR=${#BUFFER}
      zle reset-prompt
      zle -R
      return 1
      ;;
    *)
      BUFFER=""
      CURSOR=0
      zle -M "ish cancelled $rule; no command was run"
      zle reset-prompt
      zle -R
      return 1
      ;;
  esac
}

_ish_report_action() {
  local state="$1"
  local exit_code="${2:-}"
  local witness="${3:-}"
  local -a args
  args=(action-report --action "$_ISH_ACTIVE_ACTION" --capsule "$_ISH_CAPSULE_ID" --state "$state")
  [[ -n "$exit_code" ]] && args+=(--exit-code "$exit_code")
  [[ -n "$witness" ]] && args+=(--witness "$witness")
  _ish_async_ctl "${args[@]}"
}

_ish_report_action_sync() {
  local state="$1"
  local exit_code="${2:-}"
  local witness="${3:-}"
  local output="${4:-}"
  local -a args
  args=(action-report --action "$_ISH_ACTIVE_ACTION" --capsule "$_ISH_CAPSULE_ID" --state "$state")
  [[ -n "$exit_code" ]] && args+=(--exit-code "$exit_code")
  [[ -n "$witness" ]] && args+=(--witness "$witness")
  [[ -n "$output" ]] && args+=(--output "$output")
  command ishctl "${args[@]}" >/dev/null 2>&1
}

_ish_preexec() {
	local command_line="${1:-}"
	if [[ -n "${ISH_TRANSCRIPT_META_DIR:-}" && "${ISH_TRANSCRIPT_CAPTURE:-1}" != 0 &&
	      -z "$_ISH_PENDING_AGENT" && -z "$_ISH_PENDING_CONTROL" ]]; then
		local lowered="${command_line:l}"
		if [[ "$lowered" != *api_key* && "$lowered" != *api-key* &&
		      "$lowered" != *access_token* && "$lowered" != *access-token* &&
		      "$lowered" != *password* && "$lowered" != *passwd* &&
		      "$lowered" != *credential* && "$lowered" != *private_key* && "$lowered" != *private-key* &&
		      "$lowered" != *id_rsa* && "$lowered" != *ish\ config\ set\ key* &&
		      "$lowered" != *sudo\ -S* ]]; then
			(( _ISH_TRANSCRIPT_SEQ += 1 ))
			_ISH_TRANSCRIPT_ID="${$}-${_ISH_TRANSCRIPT_SEQ}"
			export ISH_TRANSCRIPT_EXPECT_ID="$_ISH_TRANSCRIPT_ID"
			export ISH_TRANSCRIPT_STATUS=active
			print -rn -- "$command_line" >"$ISH_TRANSCRIPT_META_DIR/${_ISH_TRANSCRIPT_ID}.command"
			print -rn -- "$PWD" >"$ISH_TRANSCRIPT_META_DIR/${_ISH_TRANSCRIPT_ID}.cwd"
			print -rn -- "${EPOCHREALTIME:-0}" >"$ISH_TRANSCRIPT_META_DIR/${_ISH_TRANSCRIPT_ID}.started"
			command chmod 600 -- "$ISH_TRANSCRIPT_META_DIR/${_ISH_TRANSCRIPT_ID}."{command,cwd,started} 2>/dev/null || true
			print -rn -- $'\e]777;ish;start;'"$_ISH_TRANSCRIPT_ID"$'\a'
		else
			export ISH_TRANSCRIPT_EXPECT_ID=""
			export ISH_TRANSCRIPT_STATUS=excluded-sensitive-command
		fi
	fi
  [[ -n "$_ISH_CAPSULE_ID" ]] || return 0
  _ish_async_ctl capsule-update --id "$_ISH_CAPSULE_ID" --generation "$_ISH_GENERATION" --cwd "$PWD" --mode running --line-editor inactive
  if [[ -n "$_ISH_ACTIVE_ACTION" ]]; then
    _ish_report_action running
  fi
}

_ish_precmd() {
  local previous_status=$?
	if [[ -n "$_ISH_TRANSCRIPT_ID" ]]; then
		print -rn -- $'\e]777;ish;end;'"$_ISH_TRANSCRIPT_ID"";$previous_status"$'\a'
		_ISH_TRANSCRIPT_ID=""
	fi
  if [[ -n "$_ISH_PENDING_AGENT" ]]; then
    local prompt="$_ISH_PENDING_AGENT"
    _ISH_PENDING_AGENT=""
    if (( $+commands[ishctl] )); then
      ISH_TUI=1 command ishctl ask -- "$prompt"
    else
      print -u2 -r -- "ish: agent support is unavailable; run 'ish doctor'"
    fi
  elif [[ -n "$_ISH_PENDING_CONTROL" ]]; then
    local control="$_ISH_PENDING_CONTROL"
    _ISH_PENDING_CONTROL=""
    ISH_TUI=1 command ishctl shell-control -- "$control"
  fi
  if (( _ISH_RESTORE_HIST_IGNORE_SPACE )); then
    unsetopt hist_ignore_space
    _ISH_RESTORE_HIST_IGNORE_SPACE=0
  fi
  [[ -n "$_ISH_CAPSULE_ID" ]] || return 0
  if [[ -n "$_ISH_ACTIVE_ACTION" ]]; then
    if (( previous_status == 0 )); then
      _ish_report_action succeeded "$previous_status"
    else
      _ish_report_action failed "$previous_status" "command exited with status $previous_status"
    fi
    _ISH_ACTIVE_ACTION=""
    _ISH_ACTIVE_COMMAND=""
  fi
  (( _ISH_GENERATION += 1 ))
  _ish_async_ctl capsule-update --id "$_ISH_CAPSULE_ID" --generation "$_ISH_GENERATION" --cwd "$PWD" --mode prompt --line-editor ready
}

_ish_action_ready_widget() {
  emulate -L zsh
  local fd="$1"
  local wire
  if ! IFS= read -r -u "$fd" wire; then
    zle -F "$fd" 2>/dev/null || true
    return
  fi

  local protocol action_id capsule_id expected_generation expected_cwd_token expires_ms effect_class command_payload
  IFS=$'\t' read -r protocol action_id capsule_id expected_generation expected_cwd_token expires_ms effect_class command_payload <<< "$wire"
  local witness=""

  if [[ "$protocol" != v1 ]]; then
    witness="unsupported action envelope"
  elif [[ "$capsule_id" != "$_ISH_CAPSULE_ID" ]]; then
    witness="capsule identity mismatch"
  elif [[ "$effect_class" == unsafe ]]; then
    witness="unsafe action refused by shell"
  elif (( EPOCHSECONDS * 1000 > expires_ms )); then
    witness="action expired before shell admission"
  elif [[ -n "${_ISH_SEEN_ACTIONS[$action_id]:-}" ]]; then
    witness="duplicate operation ID"
  fi

  if [[ -n "$witness" ]]; then
    _ISH_ACTIVE_ACTION="$action_id"
    _ish_report_action denied "" "$witness"
    _ISH_ACTIVE_ACTION=""
    zle -M "ish rejected $action_id: $witness"
    zle -R
    return
  fi

  if [[ -n "$BUFFER" ]]; then
    _ISH_ACTIVE_ACTION="$action_id"
    _ish_report_action busy "" "user input buffer is not empty"
    _ISH_ACTIVE_ACTION=""
    zle -M "ish kept typed input; $action_id is busy"
    zle -R
    return
  fi

  local current_cwd_token
  current_cwd_token="$(command ishctl digest -- "$PWD" 2>/dev/null)" || current_cwd_token=""
  _ISH_SEEN_ACTIONS[$action_id]=1
  local line_editor_ready=1
  [[ "$expected_generation" == "$_ISH_GENERATION" && "$expected_cwd_token" == "$current_cwd_token" ]] || line_editor_ready=0

  local decision
  decision="$(command ishctl action-admit --action "$action_id" --capsule "$_ISH_CAPSULE_ID" --generation "$_ISH_GENERATION" --cwd-token "$current_cwd_token" --line-editor-ready "$line_editor_ready" 2>/dev/null)" || decision="reject:intentd admission unavailable"
  if [[ "$decision" != execute ]]; then
    zle -M "ish rejected $action_id: ${decision#reject:}"
    zle -R
    return
  fi

  local decoded
  decoded="$(command ishctl decode "$command_payload" 2>/dev/null)" || {
    _ISH_ACTIVE_ACTION="$action_id"
    _ish_report_action denied "" "command payload decoding failed"
    _ISH_ACTIVE_ACTION=""
    return
  }
  _ISH_ACTIVE_ACTION="$action_id"
  _ISH_ACTIVE_COMMAND="$decoded"
  zle -I
  command ishctl capsule-update --id "$_ISH_CAPSULE_ID" --generation "$_ISH_GENERATION" --cwd "$PWD" --mode running --line-editor inactive >/dev/null 2>&1 || {
    _ish_report_action_sync uncertain "" "capsule could not durably enter running state"
    _ISH_ACTIVE_ACTION=""
    _ISH_ACTIVE_COMMAND=""
    zle -R
    return
  }
  _ish_report_action_sync running
  local action_output
  local output_file="${_ISH_ACTION_FIFO}.${action_id}.output"
  command rm -f -- "$output_file"
  : >"$output_file"
  command chmod 600 -- "$output_file"
  eval "$decoded" >"$output_file" 2>&1
  local action_status=$?
  action_output="$(command cat -- "$output_file" 2>/dev/null)"
  command rm -f -- "$output_file"
  [[ -n "$action_output" ]] && print -r -- "$action_output"
  if (( action_status == 0 )); then
    _ish_report_action_sync succeeded "$action_status" "" "$action_output"
  else
    _ish_report_action_sync failed "$action_status" "command exited with status $action_status" "$action_output"
  fi
  (( _ISH_GENERATION += 1 ))
  command ishctl capsule-update --id "$_ISH_CAPSULE_ID" --generation "$_ISH_GENERATION" --cwd "$PWD" --mode prompt --line-editor ready >/dev/null 2>&1 || true
  _ISH_ACTIVE_ACTION=""
  _ISH_ACTIVE_COMMAND=""
  zle -M "ish completed $action_id with status $action_status"
  zle -R
}

_ish_shutdown_capsule() {
  [[ -n "$_ISH_CAPSULE_ID" ]] || return 0
  command ishctl capsule-unregister "$_ISH_CAPSULE_ID" >/dev/null 2>&1 || true
  (( _ISH_ACTION_FD >= 0 )) && zle -F "$_ISH_ACTION_FD" 2>/dev/null || true
  (( _ISH_ACTION_FD >= 0 )) && exec {_ISH_ACTION_FD}>&- 2>/dev/null || true
  [[ -n "$_ISH_ACTION_FIFO" ]] && command rm -f -- "$_ISH_ACTION_FIFO"
}

_ish_initialize_capsule() {
  [[ "${ISH_DISABLE_CAPSULES:-0}" == 1 ]] && return 0
  command -v ishctl >/dev/null 2>&1 || return 0
  command ishctl ping >/dev/null 2>&1 || return 0
  [[ -z "$_ISH_CAPSULE_ID" ]] || return 0
  zmodload zsh/datetime 2>/dev/null || return 0

  local runtime_root="${ISH_RUNTIME_DIR:-${XDG_RUNTIME_DIR:-/tmp}/ish-${EUID}}"
  local endpoint_dir="$runtime_root/capsules"
  command mkdir -p -m 700 -- "$endpoint_dir" || return 0
  _ISH_CAPSULE_ID="$(command ishctl capsule-id 2>/dev/null)" || { _ISH_CAPSULE_ID=""; return 0; }
  _ISH_ACTION_FIFO="$endpoint_dir/${_ISH_CAPSULE_ID}.fifo"
  command rm -f -- "$_ISH_ACTION_FIFO"
  command mkfifo -m 600 -- "$_ISH_ACTION_FIFO" || { _ISH_CAPSULE_ID=""; return 0; }
  exec {_ISH_ACTION_FD}<>"$_ISH_ACTION_FIFO" || { command rm -f -- "$_ISH_ACTION_FIFO"; _ISH_CAPSULE_ID=""; return 0; }

  local process_start boot_id host shell_name tmux_server session window pane
  process_start="$(command ps -o lstart= -p $$ 2>/dev/null | command tr -s ' ' '_' )"
  boot_id="$(_ish_boot_id)"
  host="$(command hostname)"
  shell_name="${ZSH_NAME:-zsh}"
  tmux_server="${TMUX%%,*}"
  [[ -n "$tmux_server" ]] || tmux_server="-"
  session="$(_ish_tmux_field '#S')"
  window="$(_ish_tmux_field '#I')"
  pane="${TMUX_PANE:--}"

  if ! command ishctl capsule-register \
    --id "$_ISH_CAPSULE_ID" --endpoint "$_ISH_ACTION_FIFO" --pid "$$" \
    --process-start "$process_start" --generation "$_ISH_GENERATION" --cwd "$PWD" \
    --host "$host" --boot-id "$boot_id" --shell "$shell_name" --authority "uid:${EUID}" \
    --tmux-server "$tmux_server" --session "$session" --window "$window" --pane "$pane" \
    >/dev/null 2>&1; then
    exec {_ISH_ACTION_FD}>&-
    command rm -f -- "$_ISH_ACTION_FIFO"
    _ISH_ACTION_FD=-1
    _ISH_ACTION_FIFO=""
    _ISH_CAPSULE_ID=""
    return 0
  fi

  zle -N _ish_action_ready_widget
  zle -F -w "$_ISH_ACTION_FD" _ish_action_ready_widget

  local parent_pid=$$
  local capsule_id="$_ISH_CAPSULE_ID"
  (
    while command kill -0 "$parent_pid" 2>/dev/null; do
      command sleep 5
      command kill -0 "$parent_pid" 2>/dev/null || break
      command ishctl capsule-heartbeat "$capsule_id" >/dev/null 2>&1 || true
    done
  ) &!
}

_ish_accept_line() {
  emulate -L zsh
  local line="$BUFFER"

  if _ish_risk_candidate "$line" && ! _ish_confirm_risk "$line"; then
    return
  fi

  if _ish_native_fast_path "$line"; then
    zle .accept-line
    return
  fi

  local route
  if [[ "$line" == \? || "$line" == \?\ * || "$line" == /ask || "$line" == /ask\ * ]]; then
    route="agent"
  else
    route="$(command ishctl route -- "$line" 2>/dev/null)" || route="native"
  fi
  case "$route" in
    agent)
      local prompt="$line"
      [[ "$prompt" == \?\ * ]] && prompt="${prompt#\? }"
      [[ "$prompt" == /ask\ * ]] && prompt="${prompt#/ask }"
      print -s -- "$line"
      _ISH_PENDING_AGENT="$prompt"
      if [[ ! -o hist_ignore_space ]]; then
        setopt hist_ignore_space
        _ISH_RESTORE_HIST_IGNORE_SPACE=1
      fi
      PREDISPLAY="$line"
      BUFFER=""
      CURSOR=0
      zle .accept-line
      return
      ;;
    control)
      print -s -- "$line"
      _ISH_PENDING_CONTROL="$line"
      if [[ ! -o hist_ignore_space ]]; then
        setopt hist_ignore_space
        _ISH_RESTORE_HIST_IGNORE_SPACE=1
      fi
      PREDISPLAY="$line"
      BUFFER=""
      CURSOR=0
      zle .accept-line
      return
      ;;
    native)
      ;;
    *)
      # Reliability rule: gateway failure or an unknown route stays native.
      ;;
  esac
  zle .accept-line
}

_ish_setup_prompt() {
  emulate -L zsh
  [[ "${ISH_PROMPT_STYLE:-full}" == (off|keep) ]] && return 0
  setopt -g prompt_subst
  typeset -g _ISH_ORIGINAL_PROMPT="${_ISH_ORIGINAL_PROMPT:-$PROMPT}"
  typeset -g _ISH_ORIGINAL_RPROMPT="${_ISH_ORIGINAL_RPROMPT:-$RPROMPT}"
  local arrow="❯"
  [[ "${ISH_ASCII:-0}" == 1 ]] && arrow=">"
  if [[ -n "${NO_COLOR:-}" || "${TERM:-}" == dumb ]]; then
    PROMPT="ish %1~ $arrow "
    RPROMPT='${_ISH_CAPSULE_ID:+intentd}'
  else
    PROMPT="%F{39}%Bish%b%f %F{244}%1~%f %(?..%F{203}exit:%?%f )%F{39}$arrow%f "
    RPROMPT='%F{244}${_ISH_CAPSULE_ID:+intentd}%f'
  fi
}

if [[ -o interactive ]]; then
  setopt prompt_subst
  zmodload zsh/datetime 2>/dev/null || true
  autoload -Uz add-zsh-hook
  add-zsh-hook preexec _ish_preexec
  add-zsh-hook precmd _ish_precmd
  add-zsh-hook zshexit _ish_shutdown_capsule
  zle -N accept-line _ish_accept_line
  _ish_initialize_capsule
  _ish_setup_prompt
fi
