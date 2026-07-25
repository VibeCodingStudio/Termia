[[ -n ${__TERMIA_HOOK_INSTALLED-} ]] && return
[[ -n ${TERMIA_SHELL_ID-} ]] || return 1
__TERMIA_HOOK_INSTALLED=1
__termia_guard=1
__termia_sequence=0
__termia_active=

autoload -Uz add-zsh-hook

__termia_b64() {
  command base64 | command tr -d '\n'
}

source "$TERMIA_HOOK_DIR/termia-ssh.sh"
source "$TERMIA_HOOK_DIR/termia-identity.sh"

__termia_ready() {
  local cwd shell_id
  shell_id=$(printf '%s' "$TERMIA_SHELL_ID" | __termia_b64)
  cwd=$(printf '%s' "$PWD" | __termia_b64)
  printf '\033]6973;R;%s;%s\007' "$shell_id" "$cwd" > /dev/tty
}

__termia_preexec() {
  [[ $__termia_guard == 0 ]] || return
  __termia_guard=1
  local command=$1 cwd shell_id
  if [[ -z $command || $command == __termia_* ]]; then
    __termia_guard=0
    return
  fi
  __termia_sequence=$((__termia_sequence + 1))
  __termia_active=$__termia_sequence
  cwd=$(printf '%s' "$PWD" | __termia_b64)
  command=$(printf '%s' "$command" | __termia_b64)
  shell_id=$(printf '%s' "$TERMIA_SHELL_ID" | __termia_b64)
  printf '\033]6973;S;%s;%s;%s;%s\007' "$shell_id" "$__termia_active" "$cwd" "$command" > /dev/tty
  __termia_guard=0
}

__termia_precmd() {
  local exit_status=$? cwd shell_id
  __termia_guard=1
  if [[ -n $__termia_active ]]; then
    cwd=$(printf '%s' "$PWD" | __termia_b64)
    shell_id=$(printf '%s' "$TERMIA_SHELL_ID" | __termia_b64)
    printf '\033]6973;E;%s;%s;%s;%s\007' "$shell_id" "$__termia_active" "$exit_status" "$cwd" > /dev/tty
    __termia_active=
  fi
  [[ $PROMPT == '[termia] '* ]] || PROMPT="[termia] $PROMPT"
  __termia_ready
  __termia_guard=0
  return "$exit_status"
}

add-zsh-hook preexec __termia_preexec
add-zsh-hook precmd __termia_precmd
__termia_guard=0
