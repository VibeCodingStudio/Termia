#!/bin/sh
[ -n "${__TERMIA_IDENTITY_WRAPPER_INSTALLED-}" ] && return
__TERMIA_IDENTITY_WRAPPER_INSTALLED=1
__termia_identity_sequence=0

__termia_identity_available() {
  [ "${TERMIA_SSH_WORKSPACE-}" = 1 ] \
    && [ -n "${TERMIA_SHELL_ID-}" ] \
    && [ -n "${TERMIA_HOOK_DIR-}" ] \
    && [ -s "$TERMIA_HOOK_DIR/identity.pub" ]
}

__termia_identity_parse_sudo() {
  __termia_identity_mode=
  __termia_identity_user=root
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -i|--login)
        [ -z "$__termia_identity_mode" ] || return 1
        __termia_identity_mode=login
        ;;
      -s|--shell)
        [ -z "$__termia_identity_mode" ] || return 1
        __termia_identity_mode=shell
        ;;
      -u|--user)
        [ "$#" -ge 2 ] || return 1
        shift
        __termia_identity_user=$1
        ;;
      --user=*)
        __termia_identity_user=${1#--user=}
        [ -n "$__termia_identity_user" ] || return 1
        ;;
      *)
        return 1
        ;;
    esac
    shift
  done
  [ -n "$__termia_identity_mode" ]
}

__termia_identity_parse_su() {
  __termia_identity_mode=
  __termia_identity_user=root
  case "${1-}" in
    -|--login)
      __termia_identity_mode=login
      shift
      ;;
    *)
      return 1
      ;;
  esac
  if [ "$#" -gt 0 ]; then
    [ "$#" -eq 1 ] || return 1
    __termia_identity_user=$1
  fi
}

__termia_identity_stage() {
  local stage
  stage=$(command mktemp -d "${TMPDIR:-/tmp}/termia-user.XXXXXXXX") || return 1
  command chmod 755 "$stage" || {
    command rm -rf -- "$stage"
    return 1
  }
  command cp -- \
    "$TERMIA_HOOK_DIR/termia.ash" \
    "$TERMIA_HOOK_DIR/termia.bash" \
    "$TERMIA_HOOK_DIR/termia.zsh" \
    "$TERMIA_HOOK_DIR/termia-ssh.sh" \
    "$TERMIA_HOOK_DIR/termia-identity.sh" \
    "$TERMIA_HOOK_DIR/identity.pub" \
    "$stage/" || {
      command rm -rf -- "$stage"
      return 1
    }
  command chmod 644 "$stage/termia.ash" "$stage/termia.bash" \
    "$stage/termia.zsh" "$stage/termia-ssh.sh" "$stage/identity.pub"
  command chmod 755 "$stage/termia-identity.sh"
  printf '%s' "$stage"
}

__termia_identity_quote() {
  printf "'%s'" "$(printf '%s' "$1" | command sed "s/'/'\\\\''/g")"
}

__termia_identity_run_sudo() {
  local stage child_shell_id exit_code
  stage=$(__termia_identity_stage) || {
    command sudo "$@"
    return $?
  }
  __termia_identity_sequence=$((__termia_identity_sequence + 1))
  child_shell_id=$TERMIA_SHELL_ID.u$__termia_identity_sequence
  __termia_guard=1
  command sudo "$@" "$stage/termia-identity.sh" \
    __termia_identity_bootstrap "$__termia_identity_mode" "$stage" \
    "$TERMIA_SHELL_ID" "$child_shell_id"
  exit_code=$?
  command rm -rf -- "$stage"
  __termia_guard=0
  return "$exit_code"
}

__termia_identity_run_su() {
  local stage child_shell_id launch exit_code
  stage=$(__termia_identity_stage) || {
    command su "$@"
    return $?
  }
  __termia_identity_sequence=$((__termia_identity_sequence + 1))
  child_shell_id=$TERMIA_SHELL_ID.u$__termia_identity_sequence
  launch="$(__termia_identity_quote "$stage/termia-identity.sh") __termia_identity_bootstrap $(__termia_identity_quote "$__termia_identity_mode") $(__termia_identity_quote "$stage") $(__termia_identity_quote "$TERMIA_SHELL_ID") $(__termia_identity_quote "$child_shell_id")"
  __termia_guard=1
  command su "$@" -c "$launch"
  exit_code=$?
  command rm -rf -- "$stage"
  __termia_guard=0
  return "$exit_code"
}

sudo() {
  if __termia_identity_available && __termia_identity_parse_sudo "$@"; then
    __termia_identity_run_sudo "$@"
  else
    command sudo "$@"
  fi
}

su() {
  if __termia_identity_available && __termia_identity_parse_su "$@"; then
    __termia_identity_run_su "$@"
  else
    command su "$@"
  fi
}

__termia_identity_b64() {
  if command -v base64 >/dev/null 2>&1; then
    command base64 | command tr -d '\n'
  else
    command ucode -e 'let fs = require("fs"); print(b64enc(fs.readfile("/dev/stdin")))'
  fi
}

__termia_identity_emit_open() {
  printf '\033]6973;U;%s;%s;%s;%s;%s;%s\007' \
    "$(printf '%s' "$1" | __termia_identity_b64)" \
    "$(printf '%s' "$2" | __termia_identity_b64)" \
    "$(printf '%s' "$3" | __termia_identity_b64)" \
    "$(printf '%s' "$4" | __termia_identity_b64)" \
    "$5" \
    "$(printf '%s' "$6" | __termia_identity_b64)" > /dev/tty
}

__termia_identity_emit_close() {
  printf '\033]6973;L;%s\007' \
    "$(printf '%s' "$1" | __termia_identity_b64)" > /dev/tty
}

__termia_identity_shell_supported() {
  local shell_path=${SHELL:-/bin/sh} shell_name resolved_shell
  shell_name=${shell_path##*/}
  resolved_shell=$(command readlink -f "$shell_path" 2>/dev/null || printf '%s' "$shell_path")
  case "$shell_name" in
    bash|zsh|ash) return 0 ;;
    sh) [ "${resolved_shell##*/}" = busybox ] ;;
    *) return 1 ;;
  esac
}

__termia_identity_shell() {
  local shell_path shell_name resolved_shell rc_file exit_code
  shell_path=${SHELL:-/bin/sh}
  [ -x "$shell_path" ] || shell_path=/bin/sh
  shell_name=${shell_path##*/}
  resolved_shell=$(command readlink -f "$shell_path" 2>/dev/null || printf '%s' "$shell_path")
  if [ "$shell_name" = sh ] && [ "${resolved_shell##*/}" = busybox ]; then
    shell_name=ash
  fi

  if [ "$5" != 1 ]; then
    unset TERMIA_PTY TERMIA_SSH_WORKSPACE TERMIA_SHELL_ID TERMIA_HOOK_DIR TERMIA_ASH_LOGIN
    if [ "$4" = login ]; then
      "$shell_path" -l
    else
      "$shell_path" -i
    fi
    return $?
  fi

  case "$shell_name" in
    bash)
      rc_file=$1/bashrc
      if [ "$4" = login ]; then
        printf '%s\n' \
          'if [[ -r "$HOME/.bash_profile" ]]; then source "$HOME/.bash_profile"; elif [[ -r "$HOME/.bash_login" ]]; then source "$HOME/.bash_login"; elif [[ -r "$HOME/.profile" ]]; then source "$HOME/.profile"; fi' \
          "source $(__termia_identity_quote "$2/termia.bash")" > "$rc_file" || return 1
      else
        printf '%s\n' \
          '[[ -r "$HOME/.bashrc" ]] && source "$HOME/.bashrc"' \
          "source $(__termia_identity_quote "$2/termia.bash")" > "$rc_file" || return 1
      fi
      TERMIA_PTY=1 TERMIA_SSH_WORKSPACE=1 TERMIA_SHELL_ID=$3 TERMIA_HOOK_DIR=$2 \
        "$shell_path" --noprofile --rcfile "$rc_file" -i
      ;;
    zsh)
      rc_file=$1/.zshrc
      printf '%s\n' \
        '[[ -r "$HOME/.zshrc" ]] && source "$HOME/.zshrc"' \
        "source $(__termia_identity_quote "$2/termia.zsh")" > "$rc_file" || return 1
      TERMIA_PTY=1 TERMIA_SSH_WORKSPACE=1 TERMIA_SHELL_ID=$3 TERMIA_HOOK_DIR=$2 \
        ZDOTDIR=$1 "$shell_path" -i
      ;;
    ash)
      TERMIA_PTY=1 TERMIA_SSH_WORKSPACE=1 TERMIA_SHELL_ID=$3 TERMIA_HOOK_DIR=$2 \
        TERMIA_ASH_LOGIN=$([ "$4" = login ] && printf 1 || printf 0) \
        ENV=$2/termia.ash "$shell_path" -i
      ;;
    *)
      if [ "$4" = login ]; then
        "$shell_path" -l
      else
        "$shell_path" -i
      fi
      ;;
  esac
  exit_code=$?
  return "$exit_code"
}

__termia_identity_openssh() {
  local runtime=$1 user=$2 port sshd_path key config pid attempts=0
  sshd_path=$(command -v sshd 2>/dev/null) || return 1
  command -v ssh-keygen >/dev/null 2>&1 || return 1
  case "$user" in ''|*[!A-Za-z0-9._-]*) return 1 ;; esac

  key=$runtime/host_key
  command ssh-keygen -q -t ed25519 -N '' -f "$key" >/dev/null 2>&1 || return 1
  __termia_identity_host_key=$(command ssh-keygen -y -f "$key" 2>/dev/null \
    | command awk 'NR == 1 { print $1 " " $2 }')
  [ -n "$__termia_identity_host_key" ] || return 1
  command cp "$3/identity.pub" "$runtime/authorized_keys" || return 1
  command chmod 600 "$runtime/authorized_keys" "$key" || return 1

  port=$((40000 + $$ % 20000))
  while [ "$attempts" -lt 16 ]; do
    config=$runtime/sshd_config
    command sed \
      -e "s|@PORT@|$port|g" \
      -e "s|@RUNTIME@|$runtime|g" \
      -e "s|@USER@|$user|g" > "$config" <<'EOF'
ListenAddress 127.0.0.1
Port @PORT@
HostKey @RUNTIME@/host_key
AuthorizedKeysFile @RUNTIME@/authorized_keys
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
UsePAM no
PermitRootLogin yes
StrictModes no
AllowUsers @USER@
PermitUserRC no
AllowAgentForwarding no
AllowTcpForwarding no
X11Forwarding no
PermitTunnel no
GatewayPorts no
PidFile @RUNTIME@/sshd.pid
LogLevel ERROR
Subsystem sftp internal-sftp
EOF
    "$sshd_path" -D -e -f "$config" > "$runtime/sshd.log" 2>&1 &
    pid=$!
    command sleep 0.05
    if command kill -0 "$pid" 2>/dev/null; then
      __termia_identity_port=$port
      __termia_identity_pid=$pid
      return 0
    fi
    command wait "$pid" 2>/dev/null
    attempts=$((attempts + 1))
    port=$((40000 + (port - 39999) % 20000))
  done
  return 1
}

__termia_identity_find_sftp() {
  local candidate
  for candidate in \
    /usr/libexec/sftp-server \
    /usr/lib/openssh/sftp-server \
    /usr/lib/ssh/sftp-server; do
    [ -x "$candidate" ] && {
      printf '%s' "$candidate"
      return 0
    }
  done
  return 1
}

__termia_identity_dropbear() {
  local runtime=$1 user=$2 stage=$3 dropbear_path help key auth port pid attempts=0
  dropbear_path=$(command -v dropbear 2>/dev/null) || return 1
  command -v dropbearkey >/dev/null 2>&1 || return 1
  __termia_identity_find_sftp >/dev/null || return 1
  help=$("$dropbear_path" -h 2>&1)
  printf '%s\n' "$help" | command grep -Eq '(^|[[:space:]])-D([[:space:]]|$)' || return 1
  case "$user" in ''|*[!A-Za-z0-9._-]*) return 1 ;; esac

  key=$runtime/dropbear_host_key
  auth=$runtime/auth
  command mkdir "$auth" || return 1
  command chmod 700 "$auth" || return 1
  command cp "$stage/identity.pub" "$auth/authorized_keys" || return 1
  command chmod 600 "$auth/authorized_keys" || return 1
  command dropbearkey -t ed25519 -f "$key" >/dev/null 2>&1 || return 1
  __termia_identity_host_key=$(command dropbearkey -y -f "$key" 2>/dev/null \
    | command awk '$1 ~ /^ssh-/ { print $1 " " $2; exit }')
  [ -n "$__termia_identity_host_key" ] || return 1

  port=$((40000 + $$ % 20000))
  while [ "$attempts" -lt 16 ]; do
    "$dropbear_path" -F -E -m -s -j -k -I 300 \
      -P "$runtime/dropbear.pid" -r "$key" -D "$auth" \
      -p "127.0.0.1:$port" > "$runtime/dropbear.log" 2>&1 &
    pid=$!
    command sleep 0.05
    if command kill -0 "$pid" 2>/dev/null; then
      __termia_identity_port=$port
      __termia_identity_pid=$pid
      return 0
    fi
    command wait "$pid" 2>/dev/null
    attempts=$((attempts + 1))
    port=$((40000 + (port - 39999) % 20000))
  done
  return 1
}

__termia_identity_cleanup() {
  if [ "${__termia_identity_opened-0}" = 1 ]; then
    __termia_identity_emit_close "$__termia_identity_child_shell_id"
    __termia_identity_opened=0
  fi
  if [ -n "${__termia_identity_pid-}" ]; then
    command kill "$__termia_identity_pid" 2>/dev/null
    command wait "$__termia_identity_pid" 2>/dev/null
    __termia_identity_pid=
  fi
  if [ -n "${__termia_identity_runtime-}" ]; then
    command rm -rf -- "$__termia_identity_runtime"
    __termia_identity_runtime=
  fi
}

__termia_identity_bootstrap() {
  local mode=$1 stage=$2 parent_shell_id=$3 child_shell_id=$4
  local runtime user cwd exit_code opened=0
  case "$mode" in login|shell) ;; *) return 2 ;; esac
  [ "${stage#/}" != "$stage" ] && [ -d "$stage" ] && [ -s "$stage/identity.pub" ] || return 2
  [ -n "$parent_shell_id" ] && [ -n "$child_shell_id" ] || return 2

  runtime=$(command mktemp -d "${TMPDIR:-/tmp}/termia-sidecar.XXXXXXXX") || return 1
  __termia_identity_runtime=$runtime
  __termia_identity_child_shell_id=$child_shell_id
  __termia_identity_opened=0
  __termia_identity_pid=
  trap '__termia_identity_cleanup' 0
  trap 'exit 129' HUP INT TERM
  command chmod 700 "$runtime" || return 1
  user=$(command id -un) || return 1
  cwd=$(command pwd -P) || cwd=$PWD

  if __termia_identity_shell_supported; then
    if __termia_identity_openssh "$runtime" "$user" "$stage" \
      || __termia_identity_dropbear "$runtime" "$user" "$stage"; then
      __termia_identity_emit_open "$parent_shell_id" "$child_shell_id" "$user" \
        "$cwd" "$__termia_identity_port" "$__termia_identity_host_key"
      opened=1
      __termia_identity_opened=1
    fi
  fi
  if [ "$opened" != 1 ]; then
    printf 'termia: managed user workspace unavailable; continuing with the native shell\n' >&2
  fi

  __termia_identity_shell "$runtime" "$stage" "$child_shell_id" "$mode" "$opened"
  exit_code=$?
  return "$exit_code"
}

if [ "${0##*/}" = termia-identity.sh ] && [ "${1-}" = __termia_identity_bootstrap ]; then
  shift
  __termia_identity_bootstrap "$@"
  exit $?
fi
