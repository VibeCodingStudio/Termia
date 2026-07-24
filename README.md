# Termia

Termia is a Pi-native persistent terminal with command history and managed
nested SSH workspaces. It is installed as a Pi package and remains disabled
until you run `/termia`, so Pi keeps its normal coding-agent behavior by
default.

## Install

Install [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
first:

```bash
npm install -g @earendil-works/pi-coding-agent
```

Then install Termia from npm:

```bash
pi install npm:@vibecodingstudio/termia
```

Node.js 22.19 or newer is required. Managed SSH workspaces also require
`sshfs` and `fusermount3`; macOS uses `umount`.

### From source

```bash
npm install
pi install ./
```

## Quick start

Start `pi` in a persisted session and run `/termia`. While the Agent is idle,
press `Ctrl+]` to switch between Pi and the persistent terminal.

```text
/termia           enable or disable Termia for this Pi process
Ctrl+]            switch between Agent and the persistent shell while the Agent is idle
!command          run in the persistent shell and include the result in Agent context
!!command         run in the persistent shell without adding the result to Agent context
/history          open recorded command history while Termia is enabled
```

Enabling `/termia` remembers the current Pi session and opens a fresh,
empty session under Termia-managed storage. Native `/new`, `/resume`, and
`/fork` then stay in that storage. Running `/termia` again disables the
mode and returns to the exact session that was active before enabling it.
Termia mode is never persisted and starts disabled in every new Pi process.
Inside its managed session, `/history` appears in command completion. On first
entry, Pi shows a reminder for `/history` and that `Ctrl+]` switches between
Agent and the persistent shell while the Agent is idle. Later entries still
remind you about `/history`. Any unfinished Agent prompt is preserved across
an idle switch. While the Agent is running, `Ctrl+]` is consumed silently and
is never queued for a delayed switch.

Enabling Termia also activates fixed operational guidance for evidence-first
troubleshooting, local and SSH workspace boundaries, nested SSH identity, and
high-risk operations. Pi rebuilds its base prompt when the mode-gated history
tool is activated or removed; Termia does not append that guidance on every
Agent turn. For SSH workspaces, the per-turn hook only replaces Pi's physical
working directory with the current logical `ssh://` URI so `cd` and nested SSH
handoffs remain accurate.

While disabled, Pi's `bash`, `!`, and `!!` retain their native behavior,
`termia_history` is inactive, and `/history` is not registered. `/termia`
remains available to enable the mode.

The persistent shell prompt starts with `[termia]`, so it remains visible after
scrolling. A Pi process launched from that shell keeps its native `!` behavior;
its `/termia` command refuses to create a nested Termia PTY. To ask the Agent
from the persistent shell, press `Ctrl+]` to return to Pi and submit a normal
message. The shell does not define a separate `termia` command.

While Termia mode is enabled, ordinary Pi `bash` uses Pi's detached,
non-interactive Bash backend. Local commands start in the active workspace cwd;
SSH commands reuse the authenticated Termia `ControlMaster` chain with `ssh -T`
and start in the active logical remote cwd. Multiple commands can run
concurrently, but they do not inherit aliases, functions, unexported variables,
jobs, or other process-local state from the interactive Termia shell. Their
assignments and `cd` also do not change that shell.

Ordinary Agent Bash receives no interactive stdin or controlling terminal.
Commands that require a password, confirmation, or `/dev/tty` therefore fail
normally instead of blocking; use the main `/termia` terminal for interactive
work. When Termia mode is disabled, Bash continues to use Pi's local backend.
Termia delegates the tool schema, output truncation, timeout, cancellation, and
Agent loop to Pi.

Agent `bash` output is streamed to Pi and stays completely outside Termia
history. Normal interactive shell output remains unchanged.

In `/history`, use Up/Down to move, Space to select multiple commands,
Pi's configured tool-output expansion key (`Ctrl+O` by default) to preview the
active command, and Enter to place the selected command metadata in the editor.
The metadata includes the command, cwd, exit code, time, duration, and stable
history index, but not its output.

When the Agent needs that output, it can call the extension-only
`termia_history(index, offset?, limit?)` tool. Results are ANSI-free and bounded
to 2,000 lines or 50KB; `offset` and `limit` select a 1-based line range. Tool
details report `totalLines` and `hasMore` so the Agent can continue long output
without guessing.

Enabling Termia mode moves the active conversation into
`<getAgentDir()>/termia/pi-sessions/`. `/termia`, `!command`, and `!!command`
then use the same persistent PTY, so cwd, environment variables, aliases, and
shell functions survive between commands. `Escape` interrupts a running `!` or
`!!` command.

Changing directory through terminal mode, `!`, or `!!` immediately moves that same conversation to the shell's real cwd before the Pi editor returns. Pi's footer, built-in tools, `@file`, project resources, trust checks, and third-party extensions therefore see the new directory.

## Managed SSH workspaces

From `/termia`, a plain interactive `ssh host` is managed as a workspace hop.
`ssh -4/-6`, `-p`, `-l`, and `--` are supported; commands, tunnels, custom
identity flags, and other SSH forms keep native SSH behavior. Managed hops can
nest (`local -> A -> B -> C`): every new SSH process and credential lookup runs
on its immediate parent host, so B and C keys do not need to exist locally.

While the Agent is idle, pressing `Ctrl+]` returns to Pi without closing the SSH processes. Pi keeps a
physical SSHFS mount for its built-in read/edit/write/grep/find/ls tools,
`@file`, project resources, and Agent bash transcripts, while the prompt and
status expose only the logical URI such as `ssh://user@host/srv/app`. Absolute
file paths map to the remote root; relative paths use the remote cwd. Use an absolute path
instead of `~` in file tools. Agent bash is forked by that same remote shell and
remains outside `/history`; manual commands, `!`, and `!!` retain their
SSH workspace provenance.

The local machine needs `sshfs` and `fusermount3` (macOS uses `umount`). If
SFTP is unavailable, the interactive SSH shell still works but Termia refuses
the Pi handoff instead of reading a same-named local file. A dropped mount
blocks workspace tools without retrying; run `/termia` to return to the nearest
live parent, then reconnect manually if desired. Password-authenticated hops
can be entered normally, but Termia never persists passwords or reconnects
them. Exiting hops returns through their retained parents to the directory Pi
had open before Termia. Quitting Pi closes the masters without serializing or
reconnecting the SSH chain.

The gated integration fixture proves an isolated `local -> A -> B -> C` chain,
SFTP failure, disconnect fallback, history provenance, and credential locality:

```bash
TERMIA_SSH_INTEGRATION=1 node --test test/ssh-integration.test.ts
```

## Storage

```text
~/.pi/agent/termia/history.db        command metadata
~/.pi/agent/termia/transcripts/      raw terminal output
~/.pi/agent/termia/pi-sessions/      Termia Pi sessions
~/.pi/agent/termia/retired/          superseded session forks
```

These paths are derived from Pi's public `getAgentDir()` API. Setting
`PI_CODING_AGENT_DIR` moves the complete `termia/` tree with Pi's agent
configuration. Termia mode is process-local and starts disabled on every Pi
launch. The old Go Termia database and former development storage are not read
or migrated.

## Limits

- Linux, WSL2, and macOS
- bash, zsh, BusyBox ash, and BusyBox sh interactive shells
- Pi TUI mode with a persisted session
- bounded bang results in the Pi session; full raw output remains available through `/history`
- with Termia mode enabled, Agent `bash` uses concurrent isolated child jobs and stays outside Termia history

## Uninstall

```bash
pi remove npm:@vibecodingstudio/termia
```

## Security

Pi packages execute local code. Termia starts an interactive shell, records
terminal history, and can expose managed SSH workspaces to Pi's tools. Install
it only from a source you trust, verify the active host and directory before
making changes, and review destructive commands before running them.

## License

MIT
