#!/bin/sh
set -eu

role=${TERMIA_ROLE:-${1:-}}

if [ "$role" = keygen ]; then
  rm -f /generated/local /generated/local.pub
  ssh-keygen -q -t ed25519 -N '' -f /generated/local
  exit 0
fi

wait_for_file() {
  path=$1
  count=0
  while [ ! -s "$path" ]; do
    count=$((count + 1))
    if [ "$count" -ge 200 ]; then
      echo "timed out waiting for $path" >&2
      exit 1
    fi
    sleep 0.1
  done
}

install -d -m 0700 -o termia -g termia /home/termia/.ssh
rm -f /home/termia/.ssh/authorized_keys /home/termia/.ssh/config /home/termia/.ssh/id_ed25519*

case "$role" in
  host-a)
    wait_for_file /generated/local.pub
    authorized=/generated/local.pub
    next_host=host-b
    publish=/public-keys/host-a.pub
    ;;
  host-b)
    wait_for_file /public-keys/host-a.pub
    authorized=/public-keys/host-a.pub
    next_host=host-c
    publish=/public-keys/host-b.pub
    ;;
  host-c)
    wait_for_file /public-keys/host-b.pub
    authorized=/public-keys/host-b.pub
    next_host=
    publish=
    ;;
  *)
    echo "unknown TERMIA_ROLE: $role" >&2
    exit 2
    ;;
esac

install -m 0600 -o termia -g termia "$authorized" /home/termia/.ssh/authorized_keys
if [ -n "$next_host" ]; then
  ssh-keygen -q -t ed25519 -N '' -f /home/termia/.ssh/id_ed25519
  chown termia:termia /home/termia/.ssh/id_ed25519*
  install -m 0644 /home/termia/.ssh/id_ed25519.pub "$publish.tmp"
  mv "$publish.tmp" "$publish"
  cat > /home/termia/.ssh/config <<EOF
Host $next_host
  HostName $next_host
  User termia
  IdentityFile ~/.ssh/id_ed25519
  IdentitiesOnly yes
  StrictHostKeyChecking no
  UserKnownHostsFile /dev/null
  LogLevel ERROR
EOF
  chown termia:termia /home/termia/.ssh/config
  chmod 0600 /home/termia/.ssh/config
  install -d -m 0700 /root/.ssh
  install -m 0600 /home/termia/.ssh/id_ed25519 /root/.ssh/id_ed25519
  cat > /root/.ssh/config <<EOF
Host $next_host
  HostName $next_host
  User termia
  IdentityFile ~/.ssh/id_ed25519
  IdentitiesOnly yes
  StrictHostKeyChecking no
  UserKnownHostsFile /dev/null
  LogLevel ERROR
EOF
  chmod 0600 /root/.ssh/config
fi

mkdir -p /workspace /run/sshd
printf '%s\n' "$role" > "/workspace/${role#host-}.txt"
chown -R termia:termia /workspace
printf 'root-only\n' > /root/root-only.txt
chmod 0600 /root/root-only.txt
printf 'app-only\n' > /home/app/app-only.txt
chown app:app /home/app/app-only.txt
chmod 0600 /home/app/app-only.txt
echo 'termia:termia' | chpasswd
ssh-keygen -A

cat > /usr/local/bin/termia-sftp-server <<'EOF'
#!/bin/sh
test ! -e /tmp/termia-disable-sftp || exit 1
exec /usr/lib/openssh/sftp-server
EOF
chmod 0755 /usr/local/bin/termia-sftp-server

cat > /etc/ssh/sshd_config <<'EOF'
Port 22
ListenAddress 0.0.0.0
HostKey /etc/ssh/ssh_host_ed25519_key
PasswordAuthentication yes
PubkeyAuthentication yes
PermitRootLogin no
UsePAM no
PrintMotd no
Subsystem sftp /usr/local/bin/termia-sftp-server
EOF

exec /usr/sbin/sshd -D -e
