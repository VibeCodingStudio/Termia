# Managed sudo and su workspaces

## Goal

When a user runs a supported interactive user switch inside a managed SSH
workspace, Termia must treat the resulting identity as another managed
workspace layer. The terminal, command history, cwd, file tools, `@file`, and
detached concurrent Agent Bash commands all follow the effective user. Exiting
the switched shell restores the previous identity and workspace.

The first release covers these command families when they do not include a
command to execute:

- `sudo -i`, `sudo --login`, `sudo -s`, and `sudo --shell`
- the same sudo modes with `-u USER` or `--user USER`
- `su -`, `su - USER`, and `su --login USER`

Unsupported options, explicit commands, `command sudo`, `command su`, and
absolute executable paths keep their native behavior and are not managed.

## User-visible semantics

A managed identity switch behaves like a nested SSH workspace:

```text
ssh://klein@host/home/klein
  -> sudo -i
ssh://root@host/root
  -> exit
ssh://klein@host/home/klein
```

The foreground shell remains on the existing PTY and is launched by the real
`sudo` or `su`; it is not replaced by an SSH login. The wrapper preserves the
target uid and groups, login-versus-shell mode, cwd, environment policy, target
shell, terminal size, signals, job control, and exit status. Termia adds its
shell hook and a short-lived side channel. The additional bootstrap process and
its audit entry are accepted implementation differences.

The implementation must compare the observable shell contract against the
native command for every supported mode. If a platform cannot preserve that
contract, Termia must run the native command unmanaged instead of presenting a
misleading managed workspace.

## Architecture

Termia reuses SSH as the identity side channel; it does not ship or run a
custom privileged RPC helper.

The existing shell hooks source a new identity wrapper. For a supported command
the wrapper stages the existing shell hooks and a per-terminal public key, then
invokes the real `sudo` or `su` once. A small shell bootstrap running as the
target identity starts:

1. the target user's interactive shell on the original PTY, with the matching
   bash, zsh, or BusyBox ash Termia hook; and
2. an ephemeral system OpenSSH or Dropbear server bound only to loopback, with
   public-key authentication and the target user as its only identity.

The private key never leaves the machine running Pi. The public key is copied
with the existing remote hook assets. The sidecar disables password login,
forwarding, user rc files, and unrelated SSH features. Its temporary directory,
configuration, authorized key, host key when required, and pid belong to the
target identity.

The bootstrap emits an identity-open protocol event containing the parent and
child shell ids, target user, cwd, loopback endpoint, and server kind. Termia
then creates a local OpenSSH ControlMaster whose ProxyCommand streams through
the current managed route to that loopback endpoint. This keeps the control
socket and private key local and does not require an OpenSSH client on an
OpenWrt leaf.

Once the ControlMaster is ready, the identity becomes a local route anchor in
the existing SSH chain. Existing remote Bash and SSHFS code can use that anchor
for concurrent execution and SFTP. Later ordinary SSH hops are wrapped from
the newest anchor, so chains such as this remain valid:

```text
local -> SSH A -> sudo root@A -> SSH B -> su app@B
```

The workspace URI uses the effective identity of the latest layer. The SSH
authentication identity remains separate metadata so `klein@A -> root@A` is
not mistaken for a root-authenticated connection to A.

## Platform adapters

OpenSSH is preferred on Linux and macOS. Dropbear is used on OpenWrt when its
installed build provides the required server, key, authorization-directory,
and SFTP capabilities. Selection is based on capability probes, not CPU
architecture, so the same design covers common x86, ARM, and MIPS systems
without bundled remote binaries.

The existing remote SFTP requirement remains. Termia does not install packages,
modify system SSH configuration, write a target user's permanent
`authorized_keys`, or open a non-loopback listener.

## Lifecycle and failures

The target bootstrap supervises both processes. Normal shell exit stops the sidecar,
emits identity-close, removes its temporary files, closes the ControlMaster,
unmounts the identity workspace, and restores the parent binding. SSH or PTY
loss sends the same cleanup through process-group exit and a bounded idle
timeout. Termia does not reconnect an identity workspace automatically.

Failure is fail-open for the user's terminal and fail-closed for Agent
privileges:

- Parse or policy mismatch: execute native `sudo` or `su` unchanged.
- Authentication failure: preserve the native error and exit status.
- Unsupported shell or SSH server: continue in the native switched shell and
  print one concise unmanaged-workspace warning.
- ControlMaster, SFTP, or mount failure: keep the interactive switched shell,
  do not expose target-user Agent tools, and retain the nearest live parent
  workspace.
- Sidecar loss after activation: block target-user file and Bash operations as
  disconnected until the user exits to the parent shell.

Termia never silently routes an operation requested in a root workspace through
the original unprivileged SSH account.

## Security

The identity sidecar is a temporary capability with the same lifetime as the
switched shell. It accepts only the per-terminal key, listens only on loopback,
has no password authentication or forwarding, and is reached through the
existing authenticated SSH chain. Private keys and local control sockets use
mode `0600`; temporary directories use mode `0700`.

All shell-provided event fields, usernames, paths, ports, and executable paths
are validated before command construction. Dynamic values use existing shell
quoting and argv-based process execution. Cleanup never targets a directory
that was not created and recorded by the current Termia terminal.

## Verification

Focused tests must cover:

- parsers accepting only the supported no-command sudo and su forms;
- unsupported and bypass forms passing through byte-for-byte;
- native-versus-managed uid, groups, cwd, environment, login mode, shell,
  terminal, exit-status, and startup-file behavior;
- bash, zsh, BusyBox ash, OpenSSH, and Dropbear launch construction;
- identity-open and identity-close protocol parsing and malformed-event
  rejection;
- workspace URI and cwd changes across nested SSH and identity layers;
- read, edit, SFTP, and concurrent detached Bash running as the target user;
- nested `SSH A -> sudo root -> SSH B -> su app` route construction;
- unsupported server, authentication failure, mount failure, disconnect, and
  forced-exit cleanup;
- no private-key upload, permanent authorization change, external listener,
  privilege fallback, or Termia-internal command leakage into shell history.

Before release, run the full typecheck and test suite, package dry-run, and
manual SSH tests against Linux OpenSSH, macOS OpenSSH, and an OpenWrt Dropbear
host. No npm release is part of this implementation unless requested
separately.
