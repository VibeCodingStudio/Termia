[ "${TERMIA_ASH_LOGIN-}" = 1 ] && {
  unset TERMIA_ASH_LOGIN
  __termia_env=$ENV
  [ -r /etc/profile ] && . /etc/profile
  [ -r "$HOME/.profile" ] && . "$HOME/.profile"
  [ "$ENV" = "$__termia_env" ] || [ ! -r "$ENV" ] || . "$ENV"
  unset __termia_env
}

[ -n "${__TERMIA_HOOK_INSTALLED-}" ] && return
[ -n "${TERMIA_SHELL_ID-}" ] || return 1
__TERMIA_HOOK_INSTALLED=1
__termia_guard=1
__termia_sequence=0

__termia_b64() {
  if command -v base64 >/dev/null 2>&1; then
    command base64 | command tr -d '\n'
  else
    command ucode -e 'let fs = require("fs"); print(b64enc(fs.readfile("/dev/stdin")))'
  fi
}

__termia_unb64() {
  if ! command -v base64 >/dev/null 2>&1; then
    command ucode -e 'let fs = require("fs"); print(b64dec(fs.readfile("/dev/stdin")))'
  elif command base64 -d </dev/null >/dev/null 2>&1; then
    command base64 -d
  elif command base64 --decode </dev/null >/dev/null 2>&1; then
    command base64 --decode
  else
    command base64 -D
  fi
}

. "$TERMIA_HOOK_DIR/termia-ssh.sh"

__termia_ready() {
  local __termia_cwd __termia_shell_id
  __termia_shell_id=$(printf '%s' "$TERMIA_SHELL_ID" | __termia_b64)
  __termia_cwd=$(printf '%s' "$PWD" | __termia_b64)
  printf '\033]6973;R;%s;%s;X\007' "$__termia_shell_id" "$__termia_cwd" > /dev/tty
}

__termia_complete() {
  local __termia_status __termia_history __termia_history_id __termia_command
  local __termia_cwd __termia_shell_id
  __termia_status=$1
  __termia_history=$(history 2>/dev/null | command sed -n '$p')
  __termia_history_id=$(printf '%s' "$__termia_history" \
    | command sed 's/^[[:space:]]*//; s/[[:space:]].*$//')
  case "$__termia_history_id" in
    ''|*[!0-9]*) return ;;
  esac
  [ "$__termia_history_id" -gt "$__termia_initial_history_id" ] || return
  __termia_command=$(printf '%s' "$__termia_history" \
    | command sed 's/^[[:space:]]*[0-9][0-9]*[[:space:]]*//')
  case "$__termia_command" in
    ''|__termia_exec\ *|termia|termia\ *|ssh|ssh\ *|*termia.ash*) return ;;
  esac
  __termia_shell_id=$(printf '%s' "$TERMIA_SHELL_ID" | __termia_b64)
  __termia_cwd=$(printf '%s' "$PWD" | __termia_b64)
  __termia_command=$(printf '%s' "$__termia_command" | __termia_b64)
  printf '\033]6973;C;%s;%s;%s;%s;%s\007' \
    "$__termia_shell_id" "$__termia_history_id" "$__termia_status" \
    "$__termia_cwd" "$__termia_command" > /dev/tty
}

__termia_exec() {
  local __termia_payload __termia_decoded __termia_sentinel __termia_command
  local __termia_canonical __termia_cwd __termia_shell_id __termia_agent_sequence
  local __termia_status
  __termia_payload=${1-}
  case "$__termia_payload" in
    ''|*[!A-Za-z0-9+/=]*) return 2 ;;
  esac
  __termia_decoded=$(
    printf '%s' "$__termia_payload" | __termia_unb64 2>/dev/null
    printf '\001'
  )
  __termia_sentinel=$(printf '\001')
  case "$__termia_decoded" in
    *"$__termia_sentinel") __termia_command=${__termia_decoded%"$__termia_sentinel"} ;;
    *) return 2 ;;
  esac
  __termia_canonical=$(printf '%s' "$__termia_command" | __termia_b64)
  [ "$__termia_canonical" = "$__termia_payload" ] || return 2

  __termia_guard=1
  __termia_sequence=$((__termia_sequence + 1))
  __termia_agent_sequence=$__termia_sequence
  __termia_cwd=$(printf '%s' "$PWD" | __termia_b64)
  __termia_shell_id=$(printf '%s' "$TERMIA_SHELL_ID" | __termia_b64)
  printf '\033]6973;S;%s;%s;%s;%s\007' \
    "$__termia_shell_id" "$__termia_agent_sequence" "$__termia_cwd" "$__termia_payload" > /dev/tty
  eval " $__termia_command"
  __termia_status=$?
  __termia_cwd=$(printf '%s' "$PWD" | __termia_b64)
  printf '\033]6973;E;%s;%s;%s;%s\007' \
    "$__termia_shell_id" "$__termia_agent_sequence" "$__termia_status" "$__termia_cwd" > /dev/tty
  __termia_guard=0
  return "$__termia_status"
}

termia() {
  local __termia_argv __termia_reply __termia_cwd __termia_payload __termia_shell_id
  local __termia_command __termia_termia_sequence __termia_status
  __termia_guard=1
  __termia_command=$(history 2>/dev/null | command sed -n '$s/^[[:space:]]*[0-9][0-9]*[[:space:]]*//p')
  [ -n "$__termia_command" ] || __termia_command=termia
  __termia_sequence=$((__termia_sequence + 1))
  __termia_termia_sequence=$__termia_sequence
  __termia_shell_id=$(printf '%s' "$TERMIA_SHELL_ID" | __termia_b64)
  __termia_cwd=$(printf '%s' "$PWD" | __termia_b64)
  __termia_command=$(printf '%s' "$__termia_command" | __termia_b64)
  printf '\033]6973;S;%s;%s;%s;%s\007' \
    "$__termia_shell_id" "$__termia_termia_sequence" "$__termia_cwd" "$__termia_command" > /dev/tty

  if [ "$#" -eq 0 ]; then
    __termia_argv=
  else
    __termia_argv=$(printf '%s\0' "$@" | __termia_b64)
  fi
  printf '\033]6973;Q;%s;%s;%s;%s\007' \
    "$__termia_shell_id" "$__termia_cwd" "$#" "$__termia_argv" > /dev/tty
  while IFS= read -r -s __termia_reply; do
    case "$__termia_reply" in
      D\;*)
        __termia_status=${__termia_reply#D;}
        case "$__termia_status" in
          ''|*[!0-9]*) continue ;;
        esac
        [ "$__termia_status" -le 255 ] || continue
        __termia_cwd=$(printf '%s' "$PWD" | __termia_b64)
        printf '\033]6973;E;%s;%s;%s;%s\007' \
          "$__termia_shell_id" "$__termia_termia_sequence" "$__termia_status" "$__termia_cwd" > /dev/tty
        __termia_guard=0
        return "$__termia_status"
        ;;
      X\;*)
        __termia_payload=${__termia_reply#X;}
        __termia_exec "$__termia_payload"
        ;;
    esac
  done

  __termia_cwd=$(printf '%s' "$PWD" | __termia_b64)
  printf '\033]6973;E;%s;%s;1;%s\007' \
    "$__termia_shell_id" "$__termia_termia_sequence" "$__termia_cwd" > /dev/tty
  __termia_guard=0
  return 1
}

__termia_history=$(history 2>/dev/null | command sed -n '$p')
__termia_initial_history_id=$(printf '%s' "$__termia_history" \
  | command sed 's/^[[:space:]]*//; s/[[:space:]].*$//')
case "$__termia_initial_history_id" in
  ''|*[!0-9]*) __termia_initial_history_id=-1 ;;
esac
unset __termia_history

__termia_original_ps1=${PS1-}
case "$__termia_original_ps1" in
  '[termia] '*) ;;
  *) PS1='$(__termia_complete "$?"; __termia_ready)'"[termia] $__termia_original_ps1" ;;
esac
unset __termia_original_ps1
__termia_guard=0
