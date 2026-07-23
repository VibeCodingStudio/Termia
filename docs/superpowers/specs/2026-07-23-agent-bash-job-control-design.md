# Agent Bash Job-Control Design

## Goal

Run multiple Agent Bash tool calls concurrently from the exact current Termia shell state, support repeated interactive input without making `Ctrl+]` active while the Agent is running, and keep every Agent Bash command and its output out of Termia command history.

## Required behavior

- `/termia`, `!`, and `!!` keep using the existing persistent human PTY and existing Termia history behavior.
- Agent Bash runs in a background subshell forked by the current interactive shell. It inherits the shell's snapshot at launch, including cwd, exported and unexported variables, functions, aliases, options, and virtual-environment state.
- Agent Bash mutations remain isolated in that subshell and do not change the parent shell.
- Multiple Agent Bash jobs may compute concurrently. The one physical terminal still has exactly one foreground process group at a time.
- Agent Bash commands, helper commands, output, prompts, and control traffic never create `HistoryStore` records and never extend a manual command's history-output range.
- `Ctrl+]` remains an idle-editor shortcut for switching between Agent and the main Termia PTY. It is not registered globally and is ignored by the Agent interaction UI.
- If one or more Agent jobs stop because they need the controlling terminal, Termia automatically opens an interaction UI while the Agent is waiting for tool results.
- One waiting job enters directly. Multiple waiting jobs show a selector. The selected job is foregrounded and receives raw terminal input for as many prompts as it produces.
- `Ctrl+G` leaves the selected Agent job and returns to the Agent-job selector. The job is resumed in the background; if it reads the terminal again, normal job control stops it again.
- When no job is waiting for input, the interaction UI closes and Pi continues the Agent turn.
- Timeouts and Agent aborts terminate only the affected Agent job process group and settle its Bash tool call.

## Architecture

### Current-shell fork

Add one shared, POSIX-style `termia-agent.sh` helper sourced by the Bash, Zsh, and BusyBox ash hooks. The helper accepts a Base64 command through the existing bounded-line transport, then launches it as a background subshell:

```sh
(
  __termia_guard=1
  eval "$__termia_agent_command"
  __termia_agent_status=$?
  printf '%s\n' "$__termia_agent_status" >"$__termia_agent_status_file"
  pwd -P >"$__termia_agent_cwd_file"
  exit "$__termia_agent_status"
) >"$__termia_agent_log" 2>&1 </dev/tty &
```

The fork occurs before `eval`, so the command receives the real in-memory shell snapshot rather than a reconstructed environment. The parent immediately returns to its prompt and can launch the next Agent job.

Each job receives a private directory under `/tmp/termia-agent-<shell-id>/<job-id>` containing its pid, shell job number, transcript, final cwd, and final status. Directories use mode `0700`; files use the shell's `077` umask and are deleted after the tool result is delivered.

### Job-control protocol

Extend the OSC 6973 protocol with Agent-job events that are separate from manual command `start`/`end` events:

- `agentJobStart`: shell id, job id, process-group id, cwd, and transcript path.
- `agentJobWaiting`: a background process group is stopped by terminal job control.
- `agentJobForeground`: the selected job now owns the terminal.
- `agentJobBackground`: the foreground attempt ended or was suspended.
- `agentJobEnd`: exit code and the child subshell's final cwd.

These events update an in-memory Agent-job map only. They never call `HistoryStore.startCommand()`, `appendOutput()`, `endCommand()`, or `recordObservedCommand()`.

While Agent jobs exist, the controller injects a hidden `__termia_agent_poll` only when the parent shell is ready. The helper checks the child status file first, then reads `/proc/<pid>/stat`; where `/proc` is unavailable it falls back to `ps -o state= -p <pid>`. State `T` or `t` produces `agentJobWaiting`. This avoids prompt-text matching and does not need to guess from `ECHO`.

The helper temporarily enables `stty tostop` while Agent jobs exist. Normal stdout and stderr already go to private transcripts; `TOSTOP` prevents a background program that explicitly opens `/dev/tty` from corrupting the main PTY before it is foregrounded. The previous terminal mode is restored after the last Agent job ends.

### Output and history isolation

`TerminalController.executeAgent()` replaces the current isolated call to `execute()`. It supports multiple active executions and pumps each private transcript to that Bash tool call's `onData` callback. SSH transcript paths are mapped through the already-mounted remote root; no new execution SSH channel is opened.

Internal launch, poll, foreground, background, abort, prompt, and direct `/dev/tty` output are muted from `HistoryStore`. While an Agent job is foregrounded, direct PTY output is routed to that job and to the raw interaction screen instead.

### Automatic interaction UI

The current `session_start` UI context is bound to the terminal controller. `AgentJobSelector` is opened by a waiting event, not by a keyboard shortcut:

1. If exactly one job waits, foreground it immediately.
2. If multiple jobs wait, show command, cwd, elapsed time, and state; Up/Down selects and Enter foregrounds.
3. Stop the Pi renderer while a job is foregrounded, stream its transcript and direct PTY output to the real terminal, and forward ordinary input to the PTY.
4. Consume `Ctrl+]` without action. Consume `Ctrl+G`, suspend the foreground process group, resume it in the background, and return to the selector.
5. When the selected job exits, offer the next waiting job. When none wait, close the UI and let pending Bash tool promises continue normally.

The Agent is already waiting for tool results during this UI; no model request is cancelled or restarted.

## Scope boundary

This design targets line-oriented Agent interactions such as `sudo`, package-manager confirmations, password prompts, and interactive installers. Full-screen applications such as `vim`, `top`, and `less` remain the responsibility of the main `/termia` PTY. Supporting independent full-screen Agent terminals while preserving an exact in-memory shell fork would require a native shell module or remote PTY broker and is intentionally excluded.

## Failure handling

- A malformed or unknown Agent-job frame remains terminal output, matching existing protocol behavior.
- Shell exit rejects every pending Agent Bash call and removes local transcript readers.
- A failed launch rejects only its own tool call and leaves the parent PTY usable.
- Timeout and AbortSignal paths send `SIGINT` to the job process group, then `SIGKILL` after a short grace period if it remains alive.
- UI creation is single-flight. New waiting jobs update the existing selector rather than opening another overlay.
- If the SSH workspace mount becomes unhealthy, existing workspace policy blocks new Agent Bash calls; active calls fail with the existing disconnected-workspace error.

## Validation

- Bash, Zsh, and BusyBox ash jobs inherit unexported variables, functions, aliases, options, cwd, and virtual-environment variables from their parent shell snapshot.
- Two gated Agent jobs both start before either is released, proving real background concurrency.
- Child `cd`, variable changes, and function changes do not mutate the parent shell.
- Two jobs can each request two rounds of input; the interaction UI switches between them and both complete with the correct input.
- `Ctrl+]` remains handled only by the idle `BangEditor`; it does nothing in the automatic Agent-job UI.
- Agent Bash commands and output never appear in `/termia-history`, while `!`, `!!`, and manually typed commands retain their existing history behavior.
- Abort, timeout, shell exit, nested SSH, transcript cleanup, typecheck, package tests, and existing terminal attachment tests remain green.
