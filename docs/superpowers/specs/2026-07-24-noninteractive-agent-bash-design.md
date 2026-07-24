# Non-interactive Agent Bash Design

## Goal

Make Agent Bash commands in Termia mode behave like Pi's native Bash tool: commands receive no interactive stdin or controlling terminal, so password prompts and confirmations fail promptly instead of blocking. Keep concurrent execution, the active local or SSH workspace, and the current working directory.

## Execution model

- Pi's native local Bash backend remains unchanged while Termia mode is disabled.
- While Termia mode is enabled, Agent Bash no longer runs as a background job inside the persistent interactive PTY.
- Local Agent Bash uses Pi's native detached Bash operations.
- SSH Agent Bash uses a detached, non-PTY side channel through the active Termia SSH `ControlMaster` chain. It reuses already authenticated password connections and does not reconnect interactively.
- Remote commands start in the logical remote cwd represented by the active Termia workspace.
- Agent Bash stdin is ignored, stdout and stderr are streamed to Pi, and timeout or cancellation terminates only that detached command.
- Agent Bash commands remain absent from `termia-history`.

The interactive Termia PTY remains responsible only for `/termia`, `!`, `!!`, manual terminal use, shell cwd tracking, and SSH handoff. Agent Bash does not inherit aliases, functions, unexported variables, jobs, or other process-local state from that interactive shell.

## Removed behavior

- Remove the F6 shortcut and Agent input overlays.
- Remove masked/plaintext input handling and terminal ECHO inspection.
- Remove managed-job footer state.
- Remove waiting, foreground, and background Agent protocol events and shell helpers.
- Remove terminal-path transport from Agent job start events.
- Remove process-stop polling and TTY mode changes used only for interactive Agent input.
- Remove the obsolete input-manager implementation plan and tests.

## Failure semantics

Programs that require stdin, `/dev/tty`, a password, or confirmation receive the same class of failure as Pi's native Bash backend. Termia reports the program's output and nonzero exit code; it does not prompt the user or wait for terminal input. Exact program wording may vary by OS and program version.

## Verification

- Local commands execute concurrently through Pi's detached backend.
- Remote commands reuse the existing SSH control chain, run in the active logical cwd, and receive no PTY.
- A stdin read reaches EOF promptly.
- A `sudo`-style terminal/password request exits promptly rather than becoming a managed job.
- Timeout and abort affect only the selected command.
- `/termia`, `!`, `!!`, cwd tracking, SSH workspace access, and Termia history continue to work.
- Type checking, the focused test suite, the full test suite, package dry-run, and `git diff --check` pass.
