__termia_agent_root=/tmp/termia-agent-$TERMIA_SHELL_ID
__termia_agent_tty_mode=

__termia_agent_emit() {
  printf '\033]6973;%s\007' "$1" >/dev/tty
}

__termia_agent_init() {
  local __termia_agent_old_umask __termia_agent_status
  __termia_agent_old_umask=$(umask) || return 1
  umask 077
  command mkdir -p "$__termia_agent_root"
  __termia_agent_status=$?
  [ "$__termia_agent_status" -ne 0 ] || : >>"$__termia_agent_root/jobs"
  umask "$__termia_agent_old_umask"
  [ "$__termia_agent_status" -eq 0 ] || return 1
  if [ -z "$__termia_agent_tty_mode" ]; then
    __termia_agent_tty_mode=$(command stty -g </dev/tty) || return 1
    command stty tostop </dev/tty || return 1
  fi
}

__termia_agent_process_state() {
  local __termia_agent_pid=$1 __termia_agent_stat
  if [ -r "/proc/$__termia_agent_pid/stat" ]; then
    IFS= read -r __termia_agent_stat <"/proc/$__termia_agent_pid/stat" || return 1
    __termia_agent_stat=${__termia_agent_stat##*) }
    printf '%.1s\n' "$__termia_agent_stat"
    return
  fi
  command ps -o state= -p "$__termia_agent_pid" 2>/dev/null \
    | command sed -n '1s/^[[:space:]]*\(.\).*$/\1/p'
}

__termia_agent_restore_tty() {
  local __termia_agent_dir __termia_agent_id
  if [ -f "$__termia_agent_root/jobs" ]; then
    while IFS= read -r __termia_agent_id; do
      __termia_agent_dir=$__termia_agent_root/$__termia_agent_id
      [ -f "$__termia_agent_dir/pid" ] && return
    done <"$__termia_agent_root/jobs"
  fi
  if [ -n "$__termia_agent_tty_mode" ]; then
    command stty "$__termia_agent_tty_mode" </dev/tty >/dev/null 2>&1 || :
    __termia_agent_tty_mode=
  fi
  command rmdir "$__termia_agent_root" >/dev/null 2>&1 || :
}

__termia_agent_stream() {
  local __termia_agent_id=$1 __termia_agent_payload= __termia_agent_chunk
  local __termia_agent_decoded __termia_agent_sentinel __termia_agent_command
  local __termia_agent_canonical __termia_agent_dir __termia_agent_pid
  local __termia_agent_job_line __termia_agent_job_number __termia_agent_shell_id
  local __termia_agent_start_cwd
  case "$__termia_agent_id" in ''|*[!0-9]*) return 2 ;; esac
  __termia_agent_shell_id=$(printf '%s' "$TERMIA_SHELL_ID" | __termia_b64)
  __termia_agent_emit "A;R;$__termia_agent_shell_id;$__termia_agent_id"
  while :; do
    IFS= read -r __termia_agent_chunk || continue
    [ "$__termia_agent_chunk" = . ] && break
    case "$__termia_agent_chunk" in ''|*[!A-Za-z0-9+/=]*) return 2 ;; esac
    __termia_agent_payload=$__termia_agent_payload$__termia_agent_chunk
  done
  __termia_agent_decoded=$(
    printf '%s' "$__termia_agent_payload" | __termia_unb64 2>/dev/null
    printf '\001'
  )
  __termia_agent_sentinel=$(printf '\001')
  case "$__termia_agent_decoded" in
    *"$__termia_agent_sentinel")
      __termia_agent_command=${__termia_agent_decoded%"$__termia_agent_sentinel"}
      ;;
    *) return 2 ;;
  esac
  __termia_agent_canonical=$(printf '%s' "$__termia_agent_command" | __termia_b64)
  [ "$__termia_agent_canonical" = "$__termia_agent_payload" ] || return 2
  __termia_agent_init || return 1
  __termia_agent_dir=$__termia_agent_root/$__termia_agent_id
  command mkdir "$__termia_agent_dir" || return 1
  printf '%s\n' "$__termia_agent_id" >>"$__termia_agent_root/jobs"
  (
    __termia_guard=1
    [ -z "${BASH_VERSION-}" ] || shopt -s expand_aliases
    eval "$__termia_agent_command"
    __termia_agent_status=$?
    pwd -P >"$__termia_agent_dir/cwd"
    printf '%s\n' "$__termia_agent_status" >"$__termia_agent_dir/status"
    exit "$__termia_agent_status"
  ) >"$__termia_agent_dir/output" 2>&1 </dev/tty &
  __termia_agent_pid=$!
  __termia_agent_job_line=$(jobs -l %+ 2>/dev/null | command sed -n '1p')
  __termia_agent_job_number=$(printf '%s' "$__termia_agent_job_line" \
    | command sed 's/^[^[]*\[\([0-9][0-9]*\)\].*$/\1/')
  case "$__termia_agent_job_number" in
    ''|*[!0-9]*)
      command kill "$__termia_agent_pid" >/dev/null 2>&1 || :
      return 1
      ;;
  esac
  printf '%s\n' "$__termia_agent_pid" >"$__termia_agent_dir/pid"
  printf '%s\n' "$__termia_agent_job_number" >"$__termia_agent_dir/job"
  printf '%s\n' running >"$__termia_agent_dir/state"
  __termia_agent_start_cwd=$(pwd -P)
  __termia_agent_emit "A;S;$__termia_agent_shell_id;$__termia_agent_id;$__termia_agent_pid;$(printf '%s' "$__termia_agent_start_cwd" | __termia_b64);$(printf '%s' "$__termia_agent_dir/output" | __termia_b64)"
}

__termia_agent_poll() {
  local __termia_agent_dir __termia_agent_id __termia_agent_pid
  local __termia_agent_state __termia_agent_previous __termia_agent_status
  local __termia_agent_cwd __termia_agent_shell_id
  __termia_agent_shell_id=$(printf '%s' "$TERMIA_SHELL_ID" | __termia_b64)
  [ -f "$__termia_agent_root/jobs" ] || return
  while IFS= read -r __termia_agent_id; do
    __termia_agent_dir=$__termia_agent_root/$__termia_agent_id
    [ -d "$__termia_agent_dir" ] || continue
    __termia_agent_pid=$(command sed -n '1p' "$__termia_agent_dir/pid")
    case "$__termia_agent_pid" in ''|*[!0-9]*) continue ;; esac
    if [ -f "$__termia_agent_dir/status" ]; then
      __termia_agent_status=$(command sed -n '1p' "$__termia_agent_dir/status")
      __termia_agent_cwd=$(command sed -n '1p' "$__termia_agent_dir/cwd")
      case "$__termia_agent_status" in ''|*[!0-9]*) __termia_agent_status=1 ;; esac
      wait "$__termia_agent_pid" >/dev/null 2>&1 || :
      __termia_agent_emit "A;E;$__termia_agent_shell_id;$__termia_agent_id;$__termia_agent_status;$(printf '%s' "$__termia_agent_cwd" | __termia_b64)"
      command rm -f "$__termia_agent_dir/pid" "$__termia_agent_dir/job" \
        "$__termia_agent_dir/state" "$__termia_agent_dir/status" \
        "$__termia_agent_dir/cwd"
      continue
    fi
    __termia_agent_state=$(__termia_agent_process_state "$__termia_agent_pid")
    __termia_agent_previous=$(command sed -n '1p' "$__termia_agent_dir/state")
    case "$__termia_agent_state" in
      T|t)
        if [ "$__termia_agent_previous" != waiting ]; then
          printf '%s\n' waiting >"$__termia_agent_dir/state"
          __termia_agent_emit "A;W;$__termia_agent_shell_id;$__termia_agent_id"
        fi
        ;;
      *)
        [ "$__termia_agent_previous" = running ] \
          || printf '%s\n' running >"$__termia_agent_dir/state"
        ;;
    esac
  done <"$__termia_agent_root/jobs"
  __termia_agent_restore_tty
}

__termia_agent_foreground() {
  local __termia_agent_id=$1 __termia_agent_dir __termia_agent_job
  local __termia_agent_shell_id
  case "$__termia_agent_id" in ''|*[!0-9]*) return 2 ;; esac
  __termia_agent_dir=$__termia_agent_root/$__termia_agent_id
  __termia_agent_job=$(command sed -n '1p' "$__termia_agent_dir/job")
  case "$__termia_agent_job" in ''|*[!0-9]*) return 1 ;; esac
  __termia_agent_shell_id=$(printf '%s' "$TERMIA_SHELL_ID" | __termia_b64)
  __termia_agent_emit "A;F;$__termia_agent_shell_id;$__termia_agent_id"
  fg "%$__termia_agent_job"
  __termia_agent_emit "A;B;$__termia_agent_shell_id;$__termia_agent_id"
  __termia_agent_poll
}

__termia_agent_background() {
  local __termia_agent_id=$1 __termia_agent_dir __termia_agent_job
  case "$__termia_agent_id" in ''|*[!0-9]*) return 2 ;; esac
  __termia_agent_dir=$__termia_agent_root/$__termia_agent_id
  __termia_agent_job=$(command sed -n '1p' "$__termia_agent_dir/job")
  case "$__termia_agent_job" in ''|*[!0-9]*) return 1 ;; esac
  bg "%$__termia_agent_job" >/dev/null 2>&1 || return
  printf '%s\n' running >"$__termia_agent_dir/state"
}

__termia_agent_cleanup() {
  local __termia_agent_dir __termia_agent_id
  [ -f "$__termia_agent_root/jobs" ] || return
  while IFS= read -r __termia_agent_id; do
    __termia_agent_dir=$__termia_agent_root/$__termia_agent_id
    [ -d "$__termia_agent_dir" ] || continue
    command rm -f "$__termia_agent_dir/pid" "$__termia_agent_dir/job" \
      "$__termia_agent_dir/state" "$__termia_agent_dir/status" \
      "$__termia_agent_dir/cwd" "$__termia_agent_dir/output"
    command rmdir "$__termia_agent_dir" >/dev/null 2>&1 || :
  done <"$__termia_agent_root/jobs"
  command rm -f "$__termia_agent_root/jobs"
  __termia_agent_restore_tty
}
