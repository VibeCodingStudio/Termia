[[ -n ${__TERMIA_HOOK_INSTALLED-} ]] && return
[[ -n ${TERMIA_SHELL_ID-} ]] || return 1
__TERMIA_HOOK_INSTALLED=1
__termia_guard=1
__termia_armed=0
__termia_sequence=0
__termia_active=

__termia_b64() {
  command base64 | command tr -d '\n'
}

source "$TERMIA_HOOK_DIR/termia-ssh.sh"

__termia_ready() {
  local cwd shell_id
  shell_id=$(printf '%s' "$TERMIA_SHELL_ID" | __termia_b64)
  cwd=$(printf '%s' "$PWD" | __termia_b64)
  printf '\033]6973;R;%s;%s\007' "$shell_id" "$cwd" > /dev/tty
}

__termia_debug() {
  [[ $__termia_guard == 0 && $__termia_armed == 1 ]] || return
  __termia_guard=1
  local command cwd shell_id
  command=$BASH_COMMAND
  if [[ -z $command || $command == __termia_* || $command == *termia.bash* ]]; then
    __termia_guard=0
    return
  fi
  __termia_sequence=$((__termia_sequence + 1))
  __termia_active=$__termia_sequence
  cwd=$(printf '%s' "$PWD" | __termia_b64)
  command=$(printf '%s' "$command" | __termia_b64)
  shell_id=$(printf '%s' "$TERMIA_SHELL_ID" | __termia_b64)
  printf '\033]6973;S;%s;%s;%s;%s\007' "$shell_id" "$__termia_active" "$cwd" "$command" > /dev/tty
  __termia_armed=0
  __termia_guard=0
}

__termia_before_prompt() {
  local status=$? cwd shell_id
  __termia_guard=1
  if [[ -n $__termia_active ]]; then
    cwd=$(printf '%s' "$PWD" | __termia_b64)
    shell_id=$(printf '%s' "$TERMIA_SHELL_ID" | __termia_b64)
    printf '\033]6973;E;%s;%s;%s;%s\007' "$shell_id" "$__termia_active" "$status" "$cwd" > /dev/tty
    __termia_active=
  fi
  __termia_guard=0
  return "$status"
}

__termia_after_prompt() {
  __termia_guard=1
  __termia_ready
  [[ $PS1 == '[termia] '* ]] || PS1="[termia] $PS1"
  __termia_armed=1
  __termia_guard=0
}

trap '__termia_debug' DEBUG
if declare -p PROMPT_COMMAND 2>/dev/null | command grep -q '^declare -a'; then
  PROMPT_COMMAND=(__termia_before_prompt "${PROMPT_COMMAND[@]}" __termia_after_prompt)
else
  __termia_previous_prompt_command=${PROMPT_COMMAND-}
  PROMPT_COMMAND="__termia_before_prompt${__termia_previous_prompt_command:+; $__termia_previous_prompt_command}; __termia_after_prompt"
  unset __termia_previous_prompt_command
fi
__termia_guard=0
