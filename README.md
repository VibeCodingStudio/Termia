# Termia

Termia gives [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
a persistent interactive shell, recorded command history, and managed nested
SSH workspaces. It stays disabled until you run `/termia`, so Pi keeps its
normal coding-agent behavior by default.

![Termia command history in a managed SSH workspace](https://raw.githubusercontent.com/VibeCodingStudio/Termia/main/assets/termia-preview.png)

## Install

Install Pi, then install Termia from npm:

```bash
npm install -g @earendil-works/pi-coding-agent
pi install npm:@vibecodingstudio/termia
```

Termia requires Node.js 22.19 or newer. Managed SSH workspaces also require
SSHFS. On Linux, install `sshfs` and `fusermount3`; on macOS, install a
compatible SSHFS implementation.

To install from source:

```bash
npm install
pi install ./
```

## Quick start

Start `pi` in a persisted session and run `/termia`:

```text
/termia           enable or disable Termia
/termia reset     confirm and replace the terminal with a fresh local terminal
Ctrl+]            switch between Agent and terminal while the Agent is idle
!command          run in the persistent shell and add the result to Agent context
!!command         run in the persistent shell without adding it to Agent context
/history          open recorded command history
```

Termia mode starts disabled in every Pi process. Enabling it opens a fresh,
empty Termia session and remembers the session you came from. Running
`/termia` again disables the mode and returns to that original session.

The persistent terminal prompt begins with `[termia]`. Press `Ctrl+]` while the
Agent is idle to move between Pi and the terminal without stopping the shell or
discarding an unfinished prompt. While the Agent is running, the shortcut is
ignored instead of being queued for a later switch.

## Persistent shell and Agent commands

Commands typed in the terminal, or submitted with `!` and `!!`, share one
persistent shell. Its cwd, exported and unexported variables, aliases,
functions, and jobs survive between commands. `Escape` interrupts a running
`!` or `!!` command.

Agent Bash commands are different: they run as detached, concurrent,
non-interactive jobs and stay outside Termia command history. They start in the
active local or SSH workspace but do not inherit process-local shell state, and
their `cd` or assignments do not modify the persistent shell.

Because Agent Bash has no interactive input or controlling terminal, commands
that require a password, confirmation, or `/dev/tty` fail normally instead of
blocking. Use the persistent terminal for `sudo` passwords, interactive package
upgrades, and other prompts.

## Command history

Termia records interactive commands with their cwd, exit code, time, duration,
and workspace. Open `/history`, move with Up/Down, select entries with Space,
preview the active entry with Pi's tool-output expansion key (`Ctrl+O` by
default), and press Enter to add compact history references to the Pi editor.
The Agent can then inspect the selected command output on demand without
filling the prompt with the full transcript.

Manual commands, `!`, and `!!` are recorded. Agent Bash commands are not.

## Managed SSH workspaces

From the persistent terminal, a plain interactive `ssh host` becomes a managed
workspace. `ssh -4`, `ssh -6`, `-p`, `-l`, and `--` are supported. SSH commands,
tunnels, and other advanced forms keep their normal SSH behavior.

Managed hops can nest, for example `local -> A -> B -> C`. Each hop runs from
its immediate parent, so credentials needed for B or C remain on the parent
host. Pressing `Ctrl+]` returns to Pi without closing the SSH chain. Pi's file
tools, `@file`, project resources, and Agent Bash then operate on the active
remote workspace, while the interface shows a logical cwd such as:

```text
ssh://user@example.com/srv/app
```

### Active Workspace and recovery

Agent tools follow the committed Active Workspace, not every transient hop in
the terminal. A route, mount, or Pi session-handoff failure leaves the terminal
in a Pending Workspace while the Agent stays in the previous Active Workspace.

If a remote Active Workspace disconnects, Termia retains its `ssh://` identity.
Remote Agent file operations and Bash are blocked until it is recovered, while
local absolute file reads remain possible. Closing the failed hop in the
terminal is the normal recovery path.

`/termia reset` is the explicit fallback. After confirmation, Termia stages a
fresh local terminal and Pi session, swaps them in only after the handoff
succeeds, and then discards the old terminal and SSH chain. A failure before the
runtime swap keeps the old runtime active. Reset is never automatic and loses
running terminal jobs and process-local shell state. It is not a guarantee of
recovery from process crashes or failures after the runtime swap completes.

SSH file access requires both SSHFS on the local machine and SFTP on the remote
host. If file access is unavailable, the interactive SSH shell can continue,
but Termia will not expose that remote workspace to Pi. A dropped connection or
mount is not reconnected automatically; return to a live parent and reconnect
manually. Password-authenticated SSH works interactively, but Termia never
stores or replays passwords.

Exiting SSH returns through the retained parent hops and finally to the local
directory that was active before the first hop. Quitting Pi closes the managed
SSH connections.

### Managed user switches

Inside a managed SSH shell, Termia also manages these interactive, no-command
user switches:

```text
sudo -i
sudo -s
sudo -u app -i
sudo --user=app --shell
su -
su - app
su --login app
```

After the switch, cwd and history follow the target shell, and Pi file tools,
`@file`, and concurrent Agent Bash jobs use the effective user. The workspace
URI changes accordingly, for example from `ssh://klein@host/home/klein` to
`ssh://root@host/root`. Exiting the switched shell restores the exact parent
SSH workspace; switches and SSH hops can be nested in either order.

Other forms, including `sudo command`, `sudo -u app command`, `sudo -E -i`,
`su app`, and `su - app -c command`, run as native `sudo` or `su` commands.
Using `command sudo`, `command su`, or an absolute executable path also bypasses
Termia's shell wrappers.

Managed user switching requires a usable system OpenSSH server and
`ssh-keygen`, or a Dropbear build with isolated authorization-directory support
and `dropbearkey`, on the active remote host. SFTP must also be available.
Termia starts a password-disabled, loopback-only sidecar with an ephemeral key;
the private key remains on the Pi machine and no permanent `authorized_keys`
file is changed. If these capabilities are missing or the sidecar/mount fails,
the interactive switched shell remains usable but Pi is not given target-user
file or Bash access. Termia does not reconnect it automatically.

## Storage

Termia stores its data under Pi's agent directory:

```text
~/.pi/agent/termia/history.db        command metadata
~/.pi/agent/termia/transcripts/      raw terminal output
~/.pi/agent/termia/pi-sessions/      Termia Pi sessions
~/.pi/agent/termia/retired/          superseded sessions
```

Setting `PI_CODING_AGENT_DIR` moves the complete `termia/` tree with Pi's agent
configuration.

## Limits

- Linux, WSL2, and macOS
- bash, zsh, BusyBox ash, and BusyBox sh interactive shells
- Pi TUI mode with a persisted session
- SSHFS and remote SFTP for managed SSH file access
- Remote OpenSSH or capable Dropbear for managed `sudo`/`su` workspaces

## Uninstall

```bash
pi remove npm:@vibecodingstudio/termia
```

## Security

Pi packages execute local code. Termia starts an interactive shell, records
terminal history, and can expose remote files to Pi through managed SSH
workspaces. Install it only from a source you trust, verify the active host and
directory before making changes, and review destructive commands before
running them.

## License

MIT
