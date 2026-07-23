[ -n "${__TERMIA_SSH_WRAPPER_INSTALLED-}" ] && return
__TERMIA_SSH_WRAPPER_INSTALLED=1
__termia_ssh_sequence=0

__termia_real_ssh() {
  command ssh "$@"
}

__termia_ssh_destination() {
  local destination=
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -4|-6)
        shift
        ;;
      -p|-l)
        [ "$#" -ge 2 ] || return 1
        shift 2
        ;;
      --)
        shift
        [ "$#" -eq 1 ] || return 1
        destination=$1
        shift
        ;;
      -*)
        return 1
        ;;
      *)
        [ -z "$destination" ] || return 1
        destination=$1
        shift
        [ "$#" -eq 0 ] || return 1
        ;;
    esac
  done
  [ -n "$destination" ] || return 1
  printf '%s' "$destination"
}

__termia_shell_quote() {
  printf "'%s'" "$(printf '%s' "$1" | command sed "s/'/'\\\\''/g")"
}

__termia_ssh_close_master() {
  command ssh -S "$1" -O exit "$2" >/dev/null 2>&1
}

__termia_ssh_unmanaged_master() {
  local control_path=$1 destination=$2 remote_dir=$3 exit_status
  shift 3
  if [ -n "$remote_dir" ]; then
    command ssh -S "$control_path" "$@" \
      "rm -rf -- $(__termia_shell_quote "$remote_dir")" >/dev/null 2>&1
  fi
  printf 'termia: SSH workspace unavailable; continuing with a native interactive shell\n' >&2
  command ssh -tt -S "$control_path" "$@"
  exit_status=$?
  __termia_ssh_close_master "$control_path" "$destination"
  command rm -rf -- "${control_path%/control}"
  __termia_guard=0
  return "$exit_status"
}

__termia_ssh_emit_open() {
  local parent_shell_id=$1 child_shell_id=$2 destination=$3 user=$4 host=$5
  local port=$6 control_path=$7 cwd=$8
  printf '\033]6973;H;%s;%s;%s;%s;%s;%s;%s;%s\007' \
    "$(printf '%s' "$parent_shell_id" | __termia_b64)" \
    "$(printf '%s' "$child_shell_id" | __termia_b64)" \
    "$(printf '%s' "$destination" | __termia_b64)" \
    "$(printf '%s' "$user" | __termia_b64)" \
    "$(printf '%s' "$host" | __termia_b64)" \
    "$port" \
    "$(printf '%s' "$control_path" | __termia_b64)" \
    "$(printf '%s' "$cwd" | __termia_b64)" > /dev/tty
}

__termia_ssh_emit_close() {
  printf '\033]6973;L;%s\007' "$(printf '%s' "$1" | __termia_b64)" > /dev/tty
}

ssh() {
  local destination config user host port control_dir control_path
  local metadata remote_shell remote_cwd resolved_shell remote_dir child_shell_id shell_name launch exit_status
  destination=$(__termia_ssh_destination "$@") || {
    __termia_real_ssh "$@"
    return $?
  }

  __termia_guard=1
  config=$(command ssh -G "$@") || {
    __termia_guard=0
    return 1
  }
  user=$(printf '%s\n' "$config" | command awk '$1 == "user" { value = $2 } END { print value }')
  host=$(printf '%s\n' "$config" | command awk '$1 == "hostname" { value = $2 } END { print value }')
  port=$(printf '%s\n' "$config" | command awk '$1 == "port" { value = $2 } END { print value }')
  case "$port" in ''|*[!0-9]*) __termia_guard=0; return 1 ;; esac
  [ -n "$user" ] && [ -n "$host" ] && [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || {
    __termia_guard=0
    return 1
  }

  control_dir=$(command mktemp -d "${TMPDIR:-/tmp}/termia-ssh.XXXXXXXX") || {
    __termia_guard=0
    return 1
  }
  command chmod 700 "$control_dir" || {
    command rm -rf -- "$control_dir"
    __termia_guard=0
    return 1
  }
  control_path=$control_dir/control

  command ssh -M -S "$control_path" \
    -o ControlMaster=yes \
    -o ControlPersist=no \
    -o ServerAliveInterval=15 \
    -o ServerAliveCountMax=3 \
    -fN "$@" || {
      command rm -rf -- "$control_dir"
      __termia_guard=0
      return 1
    }

  metadata=$(command ssh -S "$control_path" "$@" \
    'resolved_shell=$(command readlink -f "$SHELL" 2>/dev/null || printf "%s" "$SHELL"); printf "%s\n%s\n%s\n" "$SHELL" "$PWD" "$resolved_shell"') || {
      __termia_ssh_unmanaged_master "$control_path" "$destination" "" "$@"
      return $?
    }
  remote_shell=$(printf '%s\n' "$metadata" | command sed -n '1p')
  remote_cwd=$(printf '%s\n' "$metadata" | command sed -n '2p')
  resolved_shell=$(printf '%s\n' "$metadata" | command sed -n '3p')
  [ -n "$remote_shell" ] && [ "${remote_cwd#/}" != "$remote_cwd" ] || {
    __termia_ssh_unmanaged_master "$control_path" "$destination" "" "$@"
    return $?
  }

  remote_dir=$(command ssh -S "$control_path" "$@" \
    'umask 077; mktemp -d "${TMPDIR:-/tmp}/termia.XXXXXXXX"') || {
      __termia_ssh_unmanaged_master "$control_path" "$destination" "" "$@"
      return $?
    }
  [ "${remote_dir#/}" != "$remote_dir" ] || {
    __termia_ssh_unmanaged_master "$control_path" "$destination" "" "$@"
    return $?
  }

  command tar -C "$TERMIA_HOOK_DIR" -cf - termia.ash termia.bash termia.zsh termia-ssh.sh termia-agent.sh \
    | command ssh -S "$control_path" "$@" \
      "umask 077; tar -C $(__termia_shell_quote "$remote_dir") -xf -" || {
        __termia_ssh_unmanaged_master "$control_path" "$destination" "$remote_dir" "$@"
        return $?
      }

  printf '%s\n' \
    '[[ -r "$HOME/.bashrc" ]] && source "$HOME/.bashrc"' \
    "source $(__termia_shell_quote "$remote_dir/termia.bash")" \
    | command ssh -S "$control_path" "$@" \
      "umask 077; cat > $(__termia_shell_quote "$remote_dir/bashrc")" || {
        __termia_ssh_unmanaged_master "$control_path" "$destination" "$remote_dir" "$@"
        return $?
      }
  printf '%s\n' \
    '[[ -r "$HOME/.zshrc" ]] && source "$HOME/.zshrc"' \
    "source $(__termia_shell_quote "$remote_dir/termia.zsh")" \
    | command ssh -S "$control_path" "$@" \
      "umask 077; cat > $(__termia_shell_quote "$remote_dir/.zshrc")" || {
        __termia_ssh_unmanaged_master "$control_path" "$destination" "$remote_dir" "$@"
        return $?
      }

  __termia_ssh_sequence=$((__termia_ssh_sequence + 1))
  child_shell_id=$TERMIA_SHELL_ID.$__termia_ssh_sequence
  shell_name=${remote_shell##*/}
  if [ "$shell_name" = sh ] && [ "${resolved_shell##*/}" = busybox ]; then
    shell_name=ash
  fi
  case "$shell_name" in
    ash)
      launch="TERMIA_PTY=1 TERMIA_SHELL_ID=$(__termia_shell_quote "$child_shell_id") TERMIA_HOOK_DIR=$(__termia_shell_quote "$remote_dir") TERMIA_ASH_LOGIN=1 ENV=$(__termia_shell_quote "$remote_dir/termia.ash") exec $(__termia_shell_quote "$remote_shell") -i"
      ;;
    bash)
      launch="TERMIA_PTY=1 TERMIA_SHELL_ID=$(__termia_shell_quote "$child_shell_id") TERMIA_HOOK_DIR=$(__termia_shell_quote "$remote_dir") exec $(__termia_shell_quote "$remote_shell") --noprofile --rcfile $(__termia_shell_quote "$remote_dir/bashrc") -i"
      ;;
    zsh)
      launch="TERMIA_PTY=1 TERMIA_SHELL_ID=$(__termia_shell_quote "$child_shell_id") TERMIA_HOOK_DIR=$(__termia_shell_quote "$remote_dir") ZDOTDIR=$(__termia_shell_quote "$remote_dir") exec $(__termia_shell_quote "$remote_shell") -i"
      ;;
    *)
      __termia_ssh_unmanaged_master "$control_path" "$destination" "$remote_dir" "$@"
      return $?
      ;;
  esac

  __termia_ssh_emit_open \
    "$TERMIA_SHELL_ID" "$child_shell_id" "$destination" "$user" "$host" "$port" \
    "$control_path" "$remote_cwd"
  command ssh -tt -S "$control_path" "$@" "$launch"
  exit_status=$?
  __termia_ssh_emit_close "$child_shell_id"
  command ssh -S "$control_path" "$@" \
    "rm -rf -- $(__termia_shell_quote "$remote_dir")" >/dev/null 2>&1
  __termia_ssh_close_master "$control_path" "$destination"
  command rm -rf -- "$control_dir"
  __termia_guard=0
  return "$exit_status"
}
