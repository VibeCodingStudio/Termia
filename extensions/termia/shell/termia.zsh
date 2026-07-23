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

__termia_unb64() {
  if command base64 --decode </dev/null >/dev/null 2>&1; then
    command base64 --decode
  else
    command base64 -D
  fi
}

source "$TERMIA_HOOK_DIR/termia-ssh.sh"
source "$TERMIA_HOOK_DIR/termia-agent.sh"

__termia_ready() {
  local cwd shell_id
  shell_id=$(printf '%s' "$TERMIA_SHELL_ID" | __termia_b64)
  cwd=$(printf '%s' "$PWD" | __termia_b64)
  printf '\033]6973;R;%s;%s\007' "$shell_id" "$cwd" > /dev/tty
}

termia() {
  local __termia_argv __termia_reply __termia_cwd __termia_payload __termia_shell_id
  local __termia_decoded __termia_command __termia_canonical
  local __termia_agent_sequence __termia_status
  __termia_guard=1
  if (( $# == 0 )); then
    __termia_argv=
  else
    __termia_argv=$(printf '%s\0' "$@" | __termia_b64)
  fi
  __termia_shell_id=$(printf '%s' "$TERMIA_SHELL_ID" | __termia_b64)
  __termia_cwd=$(printf '%s' "$PWD" | __termia_b64)
  printf '\033]6973;Q;%s;%s;%s;%s\007' \
    "$__termia_shell_id" "$__termia_cwd" "$#" "$__termia_argv" > /dev/tty
  while IFS= read -r -s __termia_reply; do
    case $__termia_reply in
      D\;*)
        __termia_status=${__termia_reply#D;}
        case $__termia_status in
          ''|*[!0-9]*) continue ;;
        esac
        (( __termia_status <= 255 )) || continue
        __termia_guard=0
        return "$__termia_status"
        ;;
      X\;*)
        __termia_payload=${__termia_reply#X;}
        case $__termia_payload in
          *[!A-Za-z0-9+/=]*) continue ;;
        esac
        __termia_decoded=$(
          printf '%s' "$__termia_payload" | __termia_unb64 2>/dev/null
          printf '\001'
        )
        case $__termia_decoded in
          *$'\001') __termia_command=${__termia_decoded%$'\001'} ;;
          *) continue ;;
        esac
        __termia_canonical=$(printf '%s' "$__termia_command" | __termia_b64)
        [[ $__termia_canonical == "$__termia_payload" ]] || continue
        __termia_sequence=$((__termia_sequence + 1))
        __termia_agent_sequence=$__termia_sequence
        __termia_cwd=$(printf '%s' "$PWD" | __termia_b64)
        printf '\033]6973;S;%s;%s;%s;%s\007' \
          "$__termia_shell_id" "$__termia_agent_sequence" "$__termia_cwd" "$__termia_payload" > /dev/tty
        eval -- "$__termia_command"
        __termia_status=$?
        __termia_cwd=$(printf '%s' "$PWD" | __termia_b64)
        printf '\033]6973;E;%s;%s;%s;%s\007' \
          "$__termia_shell_id" "$__termia_agent_sequence" "$__termia_status" "$__termia_cwd" > /dev/tty
        ;;
    esac
  done
  __termia_guard=0
  return 1
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
