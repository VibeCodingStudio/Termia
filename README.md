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
/termia-history   open recorded command history
```

Enabling `/termia` remembers the current Pi session and opens a fresh,
empty session under Termia-managed storage. Native `/new`, `/resume`, and
`/fork` then stay in that storage. Running `/termia` again disables the
mode and returns to the exact session that was active before enabling it.
Termia mode is never persisted and starts disabled in every new Pi process.
On first entry, Pi shows a reminder that `Ctrl+]` switches between Agent and
the persistent shell while the Agent is idle. Any unfinished Agent prompt is
preserved across the switch.

Enabling Termia also activates fixed operational guidance for evidence-first
troubleshooting, local and SSH workspace boundaries, nested SSH identity, and
high-risk operations. Pi rebuilds its base prompt when the mode-gated history
tool is activated or removed; Termia does not append that guidance on every
Agent turn. For SSH workspaces, the per-turn hook only replaces Pi's physical
working directory with the current logical `ssh://` URI so `cd` and nested SSH
handoffs remain accurate.

While disabled, Pi's `bash`, `!`, and `!!` retain their native behavior,
`termia_history` is inactive, and `/termia` or `/termia-history` reports:

```text
Termia is disabled; run /termia to enable it
```

The persistent shell prompt starts with `[termia]`, so it remains visible after
scrolling. A Pi process launched from that shell keeps its native `!` behavior;
its `/termia` command refuses to create a nested Termia PTY.

Inside the `[termia]` shell, `termia` asks Pi a question and prints the final
answer back into that same PTY:

```text
termia "Why did the previous command fail?"
termia -n 3 --tools read,termia_history "Diagnose these commands"
termia h~10 --model openai-codex/gpt-5.2-codex "Summarize recent work"
termia --all "Review this terminal session"
termia --attach "Keep this exchange in the active Pi conversation"
```

By default this uses Pi's public print runtime with its normal Agent loop,
built-in tools, configured model/auth, skills, and global third-party
extensions, but an in-memory session with project context files disabled. It
keeps the real shell cwd, does not start another `pi` process, and does not add
the exchange to the outer conversation. `--attach` instead sends a normal user
message through the active Pi session, so that exchange and the outer
conversation's AGENTS.md/CLAUDE.md context remain active. If the shell cwd
changed, attached mode moves Pi to that cwd before sending the message.

While either kind of quick ask is active, Pi's `bash` tool keeps its existing
synchronous path in the persistent Termia PTY, alongside manual commands, `!`,
and `!!`. It therefore shares the shell's live cwd, variables, aliases, and
functions and remains part of that quick ask's Termia history.

While Termia mode is enabled, ordinary Pi `bash` instead forks an isolated
background subshell from the exact current Termia shell. It inherits the cwd,
exported and unexported variables, functions, aliases, shell options, and active
virtual environment at launch. Its assignments, option changes, and `cd` do not
change the parent shell. Multiple non-interactive Agent commands can run
concurrently, and their commands, helper traffic, prompts, and output are not
written to Termia history. When the mode is disabled, the same Pi-generated tool
definition delegates to Pi's local bash backend.
Termia delegates the tool schema, output truncation, and Agent loop to Pi and
only supplies the PTY execution operation.

If an ordinary Agent `bash` command waits for terminal input, Termia opens an
input view automatically. Terminal echo controls whether input is visible, so
password prompts mask naturally while confirmations and other input remain
visible. If several commands are waiting, choose one with Up/Down and Enter.
Repeated prompts stay in the selected view; press `Ctrl+G` to return to the job
menu. `Ctrl+]` is unavailable while the Agent is running. Use the main `/termia`
terminal for full-screen interactive programs.

Quick asks use Pi's native print behavior: Termia stays silent while Pi thinks
and runs tools, then prints only the final answer or final error. Detached mode
delegates final rendering to Pi's public `runPrintMode`; `--attach` prints the
settled answer from the active Pi conversation.

Agent `bash` output is still streamed to Pi. Quick-ask Bash keeps its stable
Termia history index but is not echoed into the terminal; ordinary Agent Bash
stays completely outside Termia history. Normal interactive shell output
remains unchanged.

`h~N`, `-n N`, and `--last N` include metadata for the last N completed Termia
commands; `--all` includes up to 1,000. Here `-n` means history count, not Pi's
session name. Command output stays out of the prompt and is fetched on demand
through `termia_history`. Other arguments are parsed by Pi, including model,
thinking, tool, extension, skill, prompt, theme, trust, and offline options.
`--print` and `--no-session` are harmless no-ops because quick asks already use
print mode without persistence. Pi session-selection/lifecycle options,
`--api-key`, `--name`, and `@file` are rejected.

During a quick ask, `Ctrl+C` aborts it and returns status 130 to the shell.
`Ctrl+]` is ignored until the quick ask finishes, leaving the shell reusable.

In `/termia-history`, use Up/Down to move, Space to select multiple commands,
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
remains outside `/termia-history`; manual commands, `!`, and `!!` retain their
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
- bounded bang results in the Pi session; full raw output remains available through `/termia-history`
- with Termia mode enabled, Agent `bash` uses the persistent PTY directly during `termia ...` and `termia --attach`; ordinary Pi bash uses concurrent isolated child jobs and stays outside Termia history

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
