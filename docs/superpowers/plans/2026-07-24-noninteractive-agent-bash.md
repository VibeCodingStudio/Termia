# Non-interactive Agent Bash Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace PTY-backed interactive Agent Bash jobs with Pi-style detached, stdin-less local and SSH execution, then delete the F6 and job-control implementation.

**Architecture:** `createModeBashOperations()` delegates local commands directly to Pi's existing `createLocalBashOperations()` backend. For SSH workspaces it wraps the command in a non-PTY command that changes to the logical remote cwd and traverses the already-authenticated `ControlMaster` hop chain; the same Pi local backend launches that wrapper detached and owns timeout, abort, and output streaming. The persistent Termia PTY is no longer involved in Agent Bash.

**Tech Stack:** TypeScript, Node child processes through Pi `BashOperations`, OpenSSH ControlMaster, Node test runner.

## Global Constraints

- Do not add a dependency or a remote helper binary.
- Do not request stdin or allocate a PTY for Agent Bash.
- Preserve concurrent Bash tool calls, workspace health checks, logical remote cwd, and SSH connection reuse.
- Keep Agent Bash out of `termia-history`.
- Preserve `/termia`, `!`, `!!`, manual PTY use, cwd tracking, and SSH handoff.
- Delete F6, input overlays, ECHO inspection, managed-job status, job-control protocol, and shell polling.
- Keep all changes uncommitted.

---

### Task 1: Detached local and SSH Bash routing

**Files:**
- Modify: `extensions/termia/ssh-workspace.ts`
- Modify: `extensions/termia/pty-bash.ts`
- Modify: `test/ssh-workspace.test.ts`
- Modify: `test/pty-bash.test.ts`

**Interfaces:**
- Produces: `buildRemoteBashCommand(hops: readonly SshHop[], cwd: string, command: string): string`.
- Produces: enabled-mode delegation to Pi's detached local Bash backend.

- [ ] **Step 1: Add failing command-construction and routing tests**

Assert that multiline commands are Base64 transported, every nested hop uses `ssh -T` with its existing control path, the wrapper changes to the absolute logical cwd, stdin reaches EOF, the Termia PTY is not started for local commands, and invalid NUL/non-absolute cwd inputs are rejected.

- [ ] **Step 2: Run tests and observe failure**

Run: `node --test test/ssh-workspace.test.ts test/pty-bash.test.ts`

Expected: FAIL because remote detached routing does not exist.

- [ ] **Step 3: Implement the minimal remote wrapper**

Generate a newline-free command equivalent to:

```sh
cd -- '<logical-cwd>' || exit
__termia_command=$(printf '%s' '<base64>' | base64 -d) || exit
if [ -n "$SHELL" ] && [ -x "$SHELL" ]; then exec "$SHELL" -c "$__termia_command"; fi
exec /bin/sh -c "$__termia_command"
```

Wrap it through the existing ControlMaster chain with `ssh -T`. Do not use stdin to transport the command.

- [ ] **Step 4: Replace PTY execution with Pi delegation**

Implement the enabled branch as:

```ts
terminal.assertWorkspace(cwd);
const binding = terminal.workspace;
const resolved = binding.target.scheme === "ssh"
  ? buildRemoteBashCommand(binding.target.hops, binding.target.path, command)
  : command;
return local.exec(resolved, cwd, options);
```

Delete duplicate timeout and abort timers; Pi's backend already owns detached process groups, ignored stdin, timeout, abort, and streaming.

- [ ] **Step 5: Run focused tests**

Run: `node --test test/ssh-workspace.test.ts test/pty-bash.test.ts`

Expected: PASS.

### Task 2: Delete interactive Agent job control

**Files:**
- Delete: `extensions/termia/agent-job-ui.ts`
- Delete: `extensions/termia/shell/termia-agent.sh`
- Delete: `test/agent-job-ui.test.ts`
- Delete: `test/agent-shell.test.ts`
- Modify: `extensions/termia/index.ts`
- Modify: `extensions/termia/protocol.ts`
- Modify: `extensions/termia/terminal.ts`
- Modify: `extensions/termia/shell/termia.ash`
- Modify: `extensions/termia/shell/termia.bash`
- Modify: `extensions/termia/shell/termia.zsh`
- Modify: `extensions/termia/shell/termia-ssh.sh`
- Modify: `extensions/termia/ssh-workspace.ts`
- Modify: `test/protocol.test.ts`
- Modify: `test/terminal.test.ts`

**Interfaces:**
- Removes: `TerminalController.executeAgent`, `setUi`, and `openAgentInputManager`.
- Removes: all `agentJob*` protocol tokens, `A;*` frames, TTY-path transport, and ECHO queries.

- [ ] **Step 1: Rewrite tests for the reduced surface**

Remove Agent lifecycle/input-manager tests. Keep manual command, quick ask, history, attach, cwd, and SSH tests. Assert that an old `A;*` frame is ordinary output.

- [ ] **Step 2: Delete shell-side Agent helpers**

Stop sourcing/copying `termia-agent.sh` from Bash, Zsh, ash, and the SSH bundle, then delete the file.

- [ ] **Step 3: Delete controller and protocol state**

Remove Agent maps, timers, control queues, transcript pumps, process signaling, input UI state, parser branches, and dispose cleanup. Retain ordinary `execute()` for manual Termia and quick asks.

- [ ] **Step 4: Delete UI and ECHO wiring**

Remove F6, session UI binding, overlay files, footer status, terminal ECHO builders, and `SshChain.terminalEcho`.

- [ ] **Step 5: Run focused regression tests**

Run: `node --test test/protocol.test.ts test/terminal.test.ts test/ssh-workspace.test.ts test/pty-bash.test.ts test/ssh-shell.test.ts`

Expected: PASS.

### Task 3: Integration, documentation, and verification

**Files:**
- Modify: `test/ssh-integration.test.ts`
- Modify: `README.md`
- Delete: `docs/superpowers/specs/2026-07-23-agent-bash-job-control-design.md`
- Delete: `docs/superpowers/plans/2026-07-23-agent-bash-job-control.md`
- Delete: `docs/superpowers/plans/2026-07-24-agent-input-manager.md`

**Interfaces:**
- Consumes: detached Bash routing from Task 1.
- Produces: integration coverage and accurate user documentation.

- [ ] **Step 1: Replace the SSH Agent integration scenario**

After reaching the third hop, run two commands concurrently through `createModeBashOperations()`. Assert both run in `/workspace`, stdin reaches EOF promptly, no Agent command enters Termia history, and the existing SSH masters are reused.

- [ ] **Step 2: Remove obsolete documentation**

Delete superseded job-control/input-manager documents. Update README to describe detached, non-interactive, parallel Agent Bash and normal password/confirmation failure.

- [ ] **Step 3: Run verification**

Run:

```sh
node --test test/pty-bash.test.ts test/protocol.test.ts test/ssh-workspace.test.ts test/terminal.test.ts
npm test
npm run typecheck
npm pack --dry-run --json
git diff --check
```

Expected: all available checks pass; environment-dependent Docker SSH tests may skip only for a documented missing prerequisite.

- [ ] **Step 4: Inspect final scope**

Run: `git status --short && git diff --stat`

Expected: only the approved replacement, deletions, tests, README, spec, and plan remain uncommitted.
