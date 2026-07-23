# Agent Bash Job Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run concurrent Agent Bash calls as isolated forks of the exact current Termia shell, automatically handle repeated interactive input, and exclude all Agent Bash activity from Termia history.

**Architecture:** Keep one persistent human PTY. The active Bash, Zsh, or BusyBox ash shell launches each Agent command as a background subshell/job-control process group, while TypeScript tracks job-only OSC events and private transcripts separately from `HistoryStore`. Waiting jobs automatically open a single Pi interaction UI; `Ctrl+]` remains an idle-only main-terminal shortcut.

**Tech Stack:** TypeScript, Node.js 22, node-pty, Pi extension UI, Bash/Zsh/BusyBox ash job control, SSHFS, Node test runner.

## Global Constraints

- Add no npm or remote runtime dependencies.
- Do not open a new SSH execution session for Agent Bash; fork from the current shell on the existing PTY.
- Preserve the current shell snapshot at job launch, including cwd, unexported variables, functions, aliases, options, and virtual-environment state.
- Keep Agent Bash mutations isolated from the parent shell.
- Never add Agent Bash commands, output, prompts, or helper traffic to Termia history.
- Keep `/termia`, `!`, `!!`, and manually typed command history unchanged.
- Keep `Ctrl+]` in `BangEditor`; do not register it with `onTerminalInput` or `registerShortcut`.
- Ignore `Ctrl+]` while the automatic Agent interaction UI is open.
- Use `Ctrl+G` only inside the automatic Agent interaction UI to return to its job selector.
- Support line-oriented interaction; do not add independent full-screen Agent terminal support.
- Support Bash, Zsh, BusyBox ash/sh, Linux/WSL2, and the existing macOS fallback.
- Do not change the package version or publish npm as part of this plan.

---

## File structure

- Create `extensions/termia/shell/termia-agent.sh`: shared current-shell fork, job registry, poll, foreground, background, and cleanup functions.
- Create `extensions/termia/agent-job-ui.ts`: pure selector model/component for waiting Agent jobs.
- Create `test/agent-shell.test.ts`: real Bash/Zsh/BusyBox shell inheritance, concurrency, and job-event tests.
- Create `test/agent-job-ui.test.ts`: selector behavior and rendering tests.
- Modify `extensions/termia/protocol.ts`: parse job-only OSC events.
- Modify `extensions/termia/shell/termia.bash`: source the shared Agent helper and keep internal commands out of Bash hooks.
- Modify `extensions/termia/shell/termia.zsh`: source the shared Agent helper and keep internal commands out of Zsh hooks.
- Modify `extensions/termia/shell/termia.ash`: source the shared Agent helper and keep internal commands out of ash observed history.
- Modify `extensions/termia/terminal.ts`: concurrent Agent-job state, transcript pumps, hidden control queue, automatic interaction loop, and signal/cleanup behavior.
- Modify `extensions/termia/pty-bash.ts`: route ordinary Agent Bash through `executeAgent()` instead of history-recorded `execute()`.
- Modify `extensions/termia/index.ts`: bind the current Pi UI context to `TerminalController` on every session start.
- Modify `extensions/termia/ssh-workspace.ts`: signal a remote Agent process group through the already-authenticated nested control chain for abort/timeout only.
- Modify `test/protocol.test.ts`, `test/pty-bash.test.ts`, `test/terminal.test.ts`, `test/ssh-workspace.test.ts`, and `test/ssh-integration.test.ts`: protocol, inheritance, concurrency, interaction, history, abort, and nested-SSH coverage.
- Modify `README.md`: document new Agent Bash behavior and remove statements that Agent Bash enters Termia history.

---

### Task 1: Agent-job protocol

**Files:**
- Modify: `extensions/termia/protocol.ts`
- Modify: `test/protocol.test.ts`

**Interfaces:**
- Produces: `AgentJobStartEvent`, `AgentJobWaitingEvent`, `AgentJobForegroundEvent`, `AgentJobBackgroundEvent`, and `AgentJobEndEvent` in `ProtocolToken`.
- Frame contract:
  - `A;S;<shell-b64>;<job-id>;<pgid>;<cwd-b64>;<transcript-b64>`
  - `A;W;<shell-b64>;<job-id>`
  - `A;F;<shell-b64>;<job-id>`
  - `A;B;<shell-b64>;<job-id>`
  - `A;E;<shell-b64>;<job-id>;<exit-code>;<cwd-b64>`

- [ ] **Step 1: Write failing parser tests**

Append exact round-trip and malformed-frame tests:

```ts
test("parses the Agent job lifecycle", () => {
  const parser = new ProtocolParser();
  const input = [
    frame(`A;S;${b64("shell-a")};7;4123;${b64("/srv/app")};${b64("/tmp/termia-agent-shell-a/7/output")}`),
    frame(`A;W;${b64("shell-a")};7`),
    frame(`A;F;${b64("shell-a")};7`),
    frame(`A;B;${b64("shell-a")};7`),
    frame(`A;E;${b64("shell-a")};7;23;${b64("/srv/app/sub")}`),
  ].join("");

  assert.deepEqual(parser.push(input), [
    {
      type: "agentJobStart",
      shellId: "shell-a",
      jobId: 7,
      processGroupId: 4123,
      cwd: "/srv/app",
      transcriptPath: "/tmp/termia-agent-shell-a/7/output",
    },
    { type: "agentJobWaiting", shellId: "shell-a", jobId: 7 },
    { type: "agentJobForeground", shellId: "shell-a", jobId: 7 },
    { type: "agentJobBackground", shellId: "shell-a", jobId: 7 },
    { type: "agentJobEnd", shellId: "shell-a", jobId: 7, exitCode: 23, cwd: "/srv/app/sub" },
  ]);
});

test("keeps malformed Agent job frames as output", () => {
  const parser = new ProtocolParser();
  for (const value of [
    frame(`A;S;${b64("shell-a")};-1;4;${b64("/tmp")};${b64("/tmp/out")}`),
    frame(`A;S;${b64("shell-a")};1;0;${b64("/tmp")};${b64("relative")}`),
    frame(`A;E;${b64("shell-a")};1;999;${b64("/tmp")}`),
    frame(`A;W;${b64("shell-a")};nope`),
  ]) {
    assert.deepEqual(parser.push(value), [{ type: "output", data: value }]);
  }
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
node --test --test-name-pattern='Agent job' test/protocol.test.ts
```

Expected: FAIL because every `A` frame is currently returned as output.

- [ ] **Step 3: Add the event types and strict parser branch**

Add these exported types and include them in `ProtocolToken`:

```ts
export type AgentJobStartEvent = {
  type: "agentJobStart";
  shellId: string;
  jobId: number;
  processGroupId: number;
  cwd: string;
  transcriptPath: string;
};
export type AgentJobWaitingEvent = { type: "agentJobWaiting"; shellId: string; jobId: number };
export type AgentJobForegroundEvent = { type: "agentJobForeground"; shellId: string; jobId: number };
export type AgentJobBackgroundEvent = { type: "agentJobBackground"; shellId: string; jobId: number };
export type AgentJobEndEvent = {
  type: "agentJobEnd";
  shellId: string;
  jobId: number;
  exitCode: number;
  cwd: string;
};
```

Parse only safe integer job ids `>= 0`, process-group ids `> 0`, exit codes `0..255`, non-empty shell ids, and absolute cwd/transcript paths. Unknown actions or wrong field counts must return `undefined`, preserving the existing malformed-frame-as-output behavior.

- [ ] **Step 4: Run GREEN and the complete parser suite**

Run:

```bash
node --test test/protocol.test.ts
npm run typecheck
```

Expected: all protocol tests and typecheck pass.

- [ ] **Step 5: Commit**

```bash
git add extensions/termia/protocol.ts test/protocol.test.ts
git commit -m "feat: add Agent job protocol"
```

---

### Task 2: Current-shell Agent job runner

**Files:**
- Create: `extensions/termia/shell/termia-agent.sh`
- Create: `test/agent-shell.test.ts`
- Modify: `extensions/termia/shell/termia.bash`
- Modify: `extensions/termia/shell/termia.zsh`
- Modify: `extensions/termia/shell/termia.ash`

**Interfaces:**
- Consumes: `__termia_b64`, `__termia_unb64`, `TERMIA_SHELL_ID`, and `__termia_guard` from each existing shell hook.
- Produces shell functions:
  - `__termia_agent_stream <job-id>`: emit `agentJobTransportReady`, receive bounded Base64 lines, fork the job, emit `agentJobStart`.
  - `__termia_agent_poll`: emit changed waiting/end states.
  - `__termia_agent_foreground <job-id>`: emit foreground/background events around `fg`.
  - `__termia_agent_background <job-id>`: resume a suspended job with `bg`.
  - `__termia_agent_cleanup`: restore tty mode and remove completed registry files.

- [ ] **Step 1: Write a failing raw-shell harness**

Create `test/agent-shell.test.ts` with a small node-pty harness that tests the shell helper without depending on the later `TerminalController.executeAgent()` API:

```ts
type ShellHarness = {
  pty: IPty;
  tokens: ProtocolToken[];
  writeLine(line: string): void;
  launch(jobId: number, command: string): void;
  waitFor<T extends ProtocolToken["type"]>(type: T, jobId?: number): Promise<Extract<ProtocolToken, { type: T }>>;
  dispose(): void;
};

async function launchAgentJob(pty: IPty, jobId: number, command: string): Promise<void> {
  const encoded = Buffer.from(command).toString("base64");
  pty.write(`__termia_agent_stream ${jobId}\r`);
  await waitFor("agentJobTransportReady", jobId);
  for (let offset = 0; offset < encoded.length; offset += 256) {
    pty.write(`${encoded.slice(offset, offset + 256)}\r`);
  }
  pty.write(".\r");
}
```

`createShellHarness(shell)` must spawn `shell -i` with `TERMIA_PTY=1`, a unique `TERMIA_SHELL_ID`, and the repository's shell-hook directory; source the matching `termia.bash`, `termia.zsh`, or `termia.ash`; parse output with `ProtocolParser`; and resolve `waitFor()` when the requested typed token arrives. Poll active jobs by writing `__termia_agent_poll\r` every 50ms until their end tokens arrive.

- [ ] **Step 2: Write failing inheritance, concurrency, and isolation tests**

For every installed supported shell, use the harness to run this parent setup:

```sh
TERMIA_PRIVATE=private-value
termia_agent_function() { printf 'function:%s\n' "$TERMIA_PRIVATE"; }
alias termia_agent_alias='printf "alias-ok\n"'
set -f
cd "$TERMIA_TEST_CWD"
```

Launch this job and assert its transcript contains all five inherited properties:

```sh
printf 'variable:%s\n' "$TERMIA_PRIVATE"
termia_agent_function
eval termia_agent_alias
printf 'options:%s\n' "$-"
printf 'cwd:%s\n' "$PWD"
TERMIA_PRIVATE=child-value
cd /
```

After its `agentJobEnd`, query the parent with `printf 'parent:%s:%s:%s\n' "$TERMIA_PRIVATE" "$PWD" "$-"` and assert it still reports `private-value`, the original cwd, and option `f`.

For concurrency, launch two jobs that each write a `ready` file, wait in a `while [ ! -f gate ]` loop, and print a unique result. Assert both ready files exist before creating either gate, then create both gates, poll, and assert both end successfully with isolated transcripts.

- [ ] **Step 3: Run RED**

Run:

```bash
node --test test/agent-shell.test.ts
```

Expected: FAIL because `termia-agent.sh` and its functions do not exist.

- [ ] **Step 4: Add the shared shell helper**

Implement one POSIX-compatible helper with this registry and lifecycle:

```sh
__termia_agent_root=/tmp/termia-agent-$TERMIA_SHELL_ID
__termia_agent_tty_mode=

__termia_agent_emit() {
  printf '\033]6973;%s\007' "$1" >/dev/tty
}

__termia_agent_init() {
  umask 077
  command mkdir -p "$__termia_agent_root" || return 1
  if [ -z "$__termia_agent_tty_mode" ]; then
    __termia_agent_tty_mode=$(command stty -g </dev/tty) || return 1
    command stty tostop </dev/tty || return 1
  fi
}

__termia_agent_stream() {
  local __termia_agent_id=$1 __termia_agent_payload= __termia_agent_chunk
  local __termia_agent_command __termia_agent_dir __termia_agent_pid
  local __termia_agent_job_line __termia_agent_job_number
  case "$__termia_agent_id" in ''|*[!0-9]*) return 2 ;; esac
  while IFS= read -r __termia_agent_chunk; do
    [ "$__termia_agent_chunk" = . ] && break
    case "$__termia_agent_chunk" in ''|*[!A-Za-z0-9+/=]*) return 2 ;; esac
    __termia_agent_payload=$__termia_agent_payload$__termia_agent_chunk
  done
  __termia_agent_command=$(printf '%s' "$__termia_agent_payload" | __termia_unb64) || return 2
  __termia_agent_init || return 1
  __termia_agent_dir=$__termia_agent_root/$__termia_agent_id
  command mkdir "$__termia_agent_dir" || return 1
  (
    __termia_guard=1
    eval "$__termia_agent_command"
    __termia_agent_status=$?
    pwd -P >"$__termia_agent_dir/cwd"
    printf '%s\n' "$__termia_agent_status" >"$__termia_agent_dir/status"
    exit "$__termia_agent_status"
  ) >"$__termia_agent_dir/output" 2>&1 </dev/tty &
  __termia_agent_pid=$!
  __termia_agent_job_line=$(jobs -l %+ 2>/dev/null | command sed -n '1p')
  __termia_agent_job_number=$(printf '%s' "$__termia_agent_job_line" | command sed 's/^[^[]*\[\([0-9][0-9]*\)\].*$/\1/')
  printf '%s\n' "$__termia_agent_pid" >"$__termia_agent_dir/pid"
  printf '%s\n' "$__termia_agent_job_number" >"$__termia_agent_dir/job"
  printf '%s\n' running >"$__termia_agent_dir/state"
  __termia_agent_emit "A;S;$(__termia_agent_shell_id);$__termia_agent_id;$__termia_agent_pid;$(pwd -P | __termia_b64);$(printf '%s' "$__termia_agent_dir/output" | __termia_b64)"
}
```

Use the same sentinel and canonical-Base64 check as ash's existing `__termia_exec` before assigning `__termia_agent_command`:

```sh
__termia_agent_decoded=$(
  printf '%s' "$__termia_agent_payload" | __termia_unb64 2>/dev/null
  printf '\001'
)
__termia_agent_sentinel=$(printf '\001')
case "$__termia_agent_decoded" in
  *"$__termia_agent_sentinel")
    __termia_agent_command=${__termia_agent_decoded%"$__termia_agent_sentinel"}
    ;;
  *) return 2 ;;
esac
__termia_agent_canonical=$(printf '%s' "$__termia_agent_command" | __termia_b64)
[ "$__termia_agent_canonical" = "$__termia_agent_payload" ] || return 2
```

Add these complete state helpers after the launcher:

```sh
__termia_agent_process_state() {
  local __termia_agent_pid=$1 __termia_agent_stat
  if [ -r "/proc/$__termia_agent_pid/stat" ]; then
    IFS= read -r __termia_agent_stat <"/proc/$__termia_agent_pid/stat" || return 1
    __termia_agent_stat=${__termia_agent_stat##*) }
    printf '%.1s\n' "$__termia_agent_stat"
    return
  fi
  command ps -o state= -p "$__termia_agent_pid" 2>/dev/null \
    | command sed -n '1s/^[[:space:]]*\(.\).*$/\1/p'
}

__termia_agent_restore_tty() {
  local __termia_agent_dir
  for __termia_agent_dir in "$__termia_agent_root"/[0-9]*; do
    [ -f "$__termia_agent_dir/pid" ] && return
  done
  if [ -n "$__termia_agent_tty_mode" ]; then
    command stty "$__termia_agent_tty_mode" </dev/tty >/dev/null 2>&1 || :
    __termia_agent_tty_mode=
  fi
  command rmdir "$__termia_agent_root" >/dev/null 2>&1 || :
}

__termia_agent_poll() {
  local __termia_agent_dir __termia_agent_id __termia_agent_pid
  local __termia_agent_state __termia_agent_previous __termia_agent_status
  local __termia_agent_cwd __termia_agent_shell_id
  __termia_agent_shell_id=$(printf '%s' "$TERMIA_SHELL_ID" | __termia_b64)
  for __termia_agent_dir in "$__termia_agent_root"/[0-9]*; do
    [ -d "$__termia_agent_dir" ] || continue
    __termia_agent_id=${__termia_agent_dir##*/}
    __termia_agent_pid=$(command sed -n '1p' "$__termia_agent_dir/pid")
    case "$__termia_agent_pid" in ''|*[!0-9]*) continue ;; esac
    if [ -f "$__termia_agent_dir/status" ]; then
      __termia_agent_status=$(command sed -n '1p' "$__termia_agent_dir/status")
      __termia_agent_cwd=$(command sed -n '1p' "$__termia_agent_dir/cwd")
      case "$__termia_agent_status" in ''|*[!0-9]*) __termia_agent_status=1 ;; esac
      wait "$__termia_agent_pid" >/dev/null 2>&1 || :
      __termia_agent_emit "A;E;$__termia_agent_shell_id;$__termia_agent_id;$__termia_agent_status;$(printf '%s' "$__termia_agent_cwd" | __termia_b64)"
      command rm -f "$__termia_agent_dir/pid" "$__termia_agent_dir/job" \
        "$__termia_agent_dir/state" "$__termia_agent_dir/status" \
        "$__termia_agent_dir/cwd"
      continue
    fi
    __termia_agent_state=$(__termia_agent_process_state "$__termia_agent_pid")
    __termia_agent_previous=$(command sed -n '1p' "$__termia_agent_dir/state")
    case "$__termia_agent_state" in
      T|t)
        if [ "$__termia_agent_previous" != waiting ]; then
          printf '%s\n' waiting >"$__termia_agent_dir/state"
          __termia_agent_emit "A;W;$__termia_agent_shell_id;$__termia_agent_id"
        fi
        ;;
      *)
        [ "$__termia_agent_previous" = running ] \
          || printf '%s\n' running >"$__termia_agent_dir/state"
        ;;
    esac
  done
  __termia_agent_restore_tty
}

__termia_agent_foreground() {
  local __termia_agent_id=$1 __termia_agent_dir __termia_agent_job
  local __termia_agent_shell_id
  case "$__termia_agent_id" in ''|*[!0-9]*) return 2 ;; esac
  __termia_agent_dir=$__termia_agent_root/$__termia_agent_id
  __termia_agent_job=$(command sed -n '1p' "$__termia_agent_dir/job")
  case "$__termia_agent_job" in ''|*[!0-9]*) return 1 ;; esac
  __termia_agent_shell_id=$(printf '%s' "$TERMIA_SHELL_ID" | __termia_b64)
  __termia_agent_emit "A;F;$__termia_agent_shell_id;$__termia_agent_id"
  fg "%$__termia_agent_job"
  __termia_agent_emit "A;B;$__termia_agent_shell_id;$__termia_agent_id"
  __termia_agent_poll
}

__termia_agent_background() {
  local __termia_agent_id=$1 __termia_agent_dir __termia_agent_job
  case "$__termia_agent_id" in ''|*[!0-9]*) return 2 ;; esac
  __termia_agent_dir=$__termia_agent_root/$__termia_agent_id
  __termia_agent_job=$(command sed -n '1p' "$__termia_agent_dir/job")
  case "$__termia_agent_job" in ''|*[!0-9]*) return 1 ;; esac
  bg "%$__termia_agent_job" >/dev/null 2>&1 || return
  printf '%s\n' running >"$__termia_agent_dir/state"
}

__termia_agent_cleanup() {
  local __termia_agent_dir
  for __termia_agent_dir in "$__termia_agent_root"/[0-9]*; do
    [ -d "$__termia_agent_dir" ] || continue
    command rm -f "$__termia_agent_dir/pid" "$__termia_agent_dir/job" \
      "$__termia_agent_dir/state" "$__termia_agent_dir/status" \
      "$__termia_agent_dir/cwd" "$__termia_agent_dir/output"
    command rmdir "$__termia_agent_dir" >/dev/null 2>&1 || :
  done
  __termia_agent_restore_tty
}
```

The TypeScript transcript pump removes `output` only after its last read, then removes the otherwise-empty job directory. Helper functions emit only `A` frames, never manual `S`, `E`, or `C` frames.

Source the helper immediately after `termia-ssh.sh` in Bash/Zsh and after `termia-ssh.sh` in ash:

```sh
. "$TERMIA_HOOK_DIR/termia-agent.sh"
```

Keep the current `__termia_*` filters intact so launch/poll/foreground commands never become observed history.

- [ ] **Step 5: Run shell syntax and focused tests**

Run:

```bash
bash -n extensions/termia/shell/termia-agent.sh extensions/termia/shell/termia.bash
zsh -n extensions/termia/shell/termia-agent.sh extensions/termia/shell/termia.zsh
busybox ash -n extensions/termia/shell/termia-agent.sh extensions/termia/shell/termia.ash
node --test test/agent-shell.test.ts
```

Expected: shell syntax succeeds and all inheritance/concurrency/isolation tests pass for installed shells.

- [ ] **Step 6: Commit**

```bash
git add extensions/termia/shell/termia-agent.sh extensions/termia/shell/termia.bash extensions/termia/shell/termia.zsh extensions/termia/shell/termia.ash test/agent-shell.test.ts
git commit -m "feat: fork Agent jobs from the active shell"
```

---

### Task 3: Concurrent Bash operations, transcripts, aborts, and history isolation

**Files:**
- Modify: `extensions/termia/terminal.ts`
- Modify: `extensions/termia/pty-bash.ts`
- Modify: `extensions/termia/ssh-workspace.ts`
- Modify: `test/pty-bash.test.ts`
- Modify: `test/terminal.test.ts`
- Modify: `test/ssh-workspace.test.ts`

**Interfaces:**
- Produces on `TerminalController`:

```ts
export type AgentExecuteOptions = {
  onOutput?: (data: string) => void;
  signal?: AbortSignal;
};

export type AgentExecutionResult = { exitCode: number };

executeAgent(command: string, options?: AgentExecuteOptions): Promise<AgentExecutionResult>;
```

- Produces on `SshChain`:

```ts
signalProcessGroup(shellId: string, processGroupId: number, signal: "INT" | "KILL"): Promise<void>;
```

- `createModeBashOperations()` calls `executeAgent()` only while Termia mode is enabled.

- [ ] **Step 1: Replace the old history expectation with failing isolation assertions**

Rename `isolates ordinary Pi bash while recording Termia history` to `isolates ordinary Pi bash without Termia history` and assert:

```ts
const before = history.listCommands(100).length;
const firstResult = await operations.exec(firstCommand, cwd, { onData: () => {} });
const secondResult = await operations.exec(secondCommand, cwd, { onData: (data) => output.push(data) });

assert.equal(firstResult.exitCode, 0);
assert.equal(secondResult.exitCode, 0);
assert.match(Buffer.concat(output).toString(), new RegExp(`unset:${cwd}`));
assert.equal(terminal.cwd, cwd);
assert.equal(history.listCommands(100).length, before);
```

Add a manual `!`/persistent `execute()` after both Agent calls and assert that it still creates exactly one history record with output that does not contain either Agent transcript.

In the same file, prepare the parent through `terminal.execute()` with an unexported variable, function, alias, `set -f`, and cwd, then call `executeAgent()` and assert the output sees all of them. A second parent `execute()` must prove the Agent child's assignments, alias/function replacements, option changes, and `cd` did not escape the subshell.

- [ ] **Step 2: Write failing timeout, abort, and per-job-output tests**

Start two jobs with distinguishable output. Abort one and allow the other to exit normally:

```ts
const abort = new AbortController();
const killed = operations.exec("printf killed-start; sleep 30", cwd, {
  onData: (data) => killedOutput.push(data),
  signal: abort.signal,
});
const survivor = operations.exec("printf survivor; sleep 0.2; printf done", cwd, {
  onData: (data) => survivorOutput.push(data),
});
abort.abort();

await assert.rejects(killed, /^Error: aborted$/);
assert.equal((await survivor).exitCode, 0);
assert.doesNotMatch(Buffer.concat(survivorOutput).toString(), /killed-start/);
```

Add this timeout assertion and verify the next Agent job still succeeds:

```ts
await assert.rejects(
  operations.exec("sleep 30", cwd, { onData: () => {}, timeout: 0.1 }),
  /^Error: timeout:0.1$/,
);
const afterTimeout = await operations.exec("printf after-timeout", cwd, {
  onData: (data) => afterTimeoutOutput.push(data),
});
assert.equal(afterTimeout.exitCode, 0);
assert.equal(Buffer.concat(afterTimeoutOutput).toString(), "after-timeout");
```

- [ ] **Step 3: Run RED**

Run:

```bash
node --test --test-name-pattern='without Termia history|aborts only|times out only' test/pty-bash.test.ts
```

Expected: FAIL because mode Bash still calls the single history-recorded `execute()` path.

- [ ] **Step 4: Add concurrent Agent execution state to `TerminalController`**

Add one map and one hidden control queue; do not add a second terminal abstraction:

```ts
type AgentExecution = {
  id: number;
  shellId: string;
  command: string;
  cwd: string;
  startedAt: number;
  processGroupId?: number;
  transcriptPath?: string;
  transcriptOffset: number;
  status: "launching" | "running" | "waiting" | "foreground" | "ended";
  onOutput?: (data: string) => void;
  signal?: AbortSignal;
  abort: () => void;
  resolve: (result: AgentExecutionResult) => void;
  reject: (error: Error) => void;
};

private readonly agentExecutions = new Map<number, AgentExecution>();
private readonly agentControlQueue: Array<() => void> = [];
private nextAgentJobId = 1;
private agentPollTimer: NodeJS.Timeout | undefined;
private agentControlMuted = false;
private activeAgentForeground: AgentExecution | undefined;
private agentScreenWrite: ((data: string) => void) | undefined;
```

`executeAgent()` must validate command/NUL/workspace like `execute()`, reserve an id immediately, register abort before queuing launch, and start this bounded transport when the parent shell is ready:

```ts
const encoded = Buffer.from(command, "utf8").toString("base64");
this.pty?.write(`__termia_agent_stream ${execution.id}\r`);
// Send the bounded payload only after agentJobTransportReady.
for (let offset = 0; offset < encoded.length; offset += EXPLICIT_EXEC_CHUNK_SIZE) {
  this.pty?.write(`${encoded.slice(offset, offset + EXPLICIT_EXEC_CHUNK_SIZE)}\r`);
}
this.pty?.write(".\r");
```

One ready event dequeues one hidden control action. While any Agent execution exists, enqueue at most one `__termia_agent_poll` every 100ms; do not write polls while the main PTY is attached, a quick ask is active, or a foreground Agent job owns the tty.

- [ ] **Step 5: Route protocol events and transcript bytes without touching history**

Handle all six Agent events before the manual command cases:

- Transport ready: send the queued Base64 payload and terminator.
- Start: verify shell id/job id, store pgid/transcript, map an SSH remote absolute transcript through `projectWorkspacePath(this.workspace, path)`, and start a 50ms offset-based file pump.
- Waiting: set `status = "waiting"` and schedule the interaction loop added in Task 4.
- Foreground/background: set/clear `activeAgentForeground` and settle the raw attachment promise.
- End: flush the transcript one final time, remove its files, detach abort listeners, resolve `{ exitCode }`, and never change the parent `cwdValue`.

Change the output branch to keep internal traffic out of history:

```ts
case "output":
  if (this.activeAgentForeground !== undefined) {
    this.activeAgentForeground.onOutput?.(token.data);
    this.agentScreenWrite?.(token.data);
    break;
  }
  if (this.agentControlMuted) break;
  this.history.appendOutput(token.data);
  // existing manual execution and attached-terminal routing follows
```

Clear `agentControlMuted` only at the ready event that completes the hidden helper invocation. This prevents helper prompts and poll output from shifting manual history boundaries.

- [ ] **Step 6: Implement targeted process-group abort**

For local jobs, call `process.kill(-processGroupId, signal)`. For SSH jobs, add a strictly numeric/whitelisted command through the existing control chain:

```ts
function buildRemoteExecCommand(hops: readonly SshHop[], remoteCommand: string): string {
  const leaf = hops.at(-1);
  if (leaf === undefined) throw new Error("Cannot execute without an SSH hop");
  let command = `ssh -S ${quote(leaf.controlPath)} ${quote(leaf.destination)} ${quote(`exec ${remoteCommand}`)}`;
  for (let index = hops.length - 2; index >= 0; index -= 1) {
    const parent = hops[index];
    if (parent === undefined) throw new Error("Invalid SSH hop chain");
    command = wrapRemote(parent, command);
  }
  return command;
}

async signalProcessGroup(
  shellId: string,
  processGroupId: number,
  signal: "INT" | "KILL",
): Promise<void> {
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 0) {
    throw new Error("Invalid Agent process group");
  }
  const index = this.hops.findIndex((state) => state.hop.shellId === shellId);
  if (index < 0) throw new Error(`Unknown SSH shell: ${shellId}`);
  const hops = this.hops.slice(0, index + 1).map((state) => state.hop);
  await runFile(
    "/bin/sh",
    ["-c", buildRemoteExecCommand(hops, `kill -${signal} -${processGroupId}`)],
    STOP_TIMEOUT_MS,
  );
}
```

Reuse `wrapRemote()` from the SSHFS bridge so nested `local -> A -> B -> C` sends the signal to C through already-authenticated masters. This channel is signal transport only; it never launches the Agent command or reconstructs shell state.

Add a unit test that asserts the C signal command contains the C master first and is wrapped by B then A, rejects an unknown shell id, and rejects pid `0`, negative pids, and unsupported signal strings at the type/runtime boundary.

Abort sends `INT`, waits 500ms for `agentJobEnd`, then sends `KILL` if still active. Reject Pi's Bash operation as `aborted` or `timeout:<seconds>` after cleanup, preserving current outward errors.

- [ ] **Step 7: Route Pi Bash to the new path**

Replace the enabled branch in `createModeBashOperations()` with:

```ts
return {
  exec: async (command, cwd, { onData, signal, timeout }) => {
    if (!terminal.running) terminal.start(cwd);
    terminal.assertWorkspace(cwd);
    const executionAbort = new AbortController();
    let timedOut = false;
    const abort = () => executionAbort.abort();
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const timer = timeout === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          executionAbort.abort();
        }, timeout * 1000);
    try {
      const result = await terminal.executeAgent(command, {
        signal: executionAbort.signal,
        onOutput: (data) => onData(Buffer.from(data)),
      });
      if (signal?.aborted) throw new Error("aborted");
      if (timedOut) throw new Error(`timeout:${timeout}`);
      return result;
    } catch (error) {
      if (signal?.aborted) throw new Error("aborted");
      if (timedOut) throw new Error(`timeout:${timeout}`);
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  },
};
```

Retain the disabled-mode `createLocalBashOperations()` branch. Remove the unused `isolated` option from `TerminalController.execute()` and its extra subshell wrapper; `!`, `!!`, and quick asks keep the existing persistent execution path.

- [ ] **Step 8: Run GREEN**

Run:

```bash
node --test test/pty-bash.test.ts test/terminal.test.ts test/ssh-workspace.test.ts
npm run typecheck
```

Expected: concurrency, per-job output, history isolation, abort, timeout, persistent human commands, and nested signal command tests pass.

- [ ] **Step 9: Commit**

```bash
git add extensions/termia/terminal.ts extensions/termia/pty-bash.ts extensions/termia/ssh-workspace.ts test/pty-bash.test.ts test/terminal.test.ts test/ssh-workspace.test.ts
git commit -m "feat: run concurrent Agent Bash jobs outside history"
```

---

### Task 4: Automatic multi-job interaction UI

**Files:**
- Create: `extensions/termia/agent-job-ui.ts`
- Create: `test/agent-job-ui.test.ts`
- Modify: `extensions/termia/terminal.ts`
- Modify: `extensions/termia/index.ts`
- Modify: `test/terminal.test.ts`
- Modify: `test/bang-editor.test.ts`

**Interfaces:**
- Produces:

```ts
export type AgentJobView = {
  id: number;
  command: string;
  cwd: string;
  startedAt: number;
  status: "running" | "waiting" | "foreground";
};

export class AgentJobSelectorModel {
  constructor(jobs: AgentJobView[]);
  selected(): AgentJobView | undefined;
  replace(jobs: AgentJobView[]): void;
  move(delta: -1 | 1): void;
}
```

- `AgentJobSelector` completes only with a selected job id. It does not treat `Ctrl+]` or Escape as terminal-switch actions.
- `TerminalController.setUi()` receives the live `ExtensionUIContext` from `session_start`.

- [ ] **Step 1: Write failing selector tests**

Cover stable selection as jobs update, Up/Down bounds, Enter, ignored `Ctrl+]`, and the exact controls line:

```ts
test("selects a waiting Agent job without handling Ctrl+]", () => {
  const selected: number[] = [];
  const model = new AgentJobSelectorModel([
    { id: 7, command: "sudo apt update", cwd: "/srv", startedAt: 1, status: "waiting" },
    { id: 8, command: "read answer", cwd: "/srv", startedAt: 2, status: "waiting" },
  ]);
  const view = new AgentJobSelector(model, fakeTheme, (id) => selected.push(id));

  view.handleInput("\u001b[B");
  view.handleInput("\x1d");
  assert.deepEqual(selected, []);
  view.handleInput("\r");
  assert.deepEqual(selected, [8]);
  assert.match(view.render(80).join("\n"), /Ctrl\+G job menu/);
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
node --test test/agent-job-ui.test.ts
```

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the minimal selector**

Follow the existing `HistoryOverlay` rendering pattern, but show only waiting/running Agent jobs and these controls:

```text
↑↓ move · Enter open · Ctrl+G job menu · Ctrl+] unavailable while Agent runs
```

Use `stripVTControlCharacters(command)`, replace control whitespace with spaces, and truncate to the available width. Do not add selection checkboxes, output preview, filtering, or persistence.

- [ ] **Step 4: Write failing automatic-takeover tests**

Add a fake `ExtensionUIContext.custom()` that records overlay opens and a raw-TTY harness based on the existing single-flight attachment tests. Start two jobs whose scripts each perform two terminal reads:

```sh
printf 'job-one:first?\n'; read -r one
printf 'job-one:second?\n'; read -r two
printf 'job-one:%s:%s\n' "$one" "$two"
```

and:

```sh
printf 'job-two:first?\n'; read -r one
printf 'job-two:second?\n'; read -r two
printf 'job-two:%s:%s\n' "$one" "$two"
```

Assert:

1. Both jobs reach `waiting` before either receives input.
2. Exactly one custom interaction loop opens.
3. Multiple jobs produce the selector; choosing job one foregrounds only job one.
4. Sending `one-a\r`, then `Ctrl+G`, returns to the selector without completing job one.
5. Choosing job two and sending `two-a\rtwo-b\r` completes job two.
6. Choosing job one again and sending `one-b\r` completes job one.
7. Both tool outputs contain only their own answers.
8. Emitting `Ctrl+]` in both selector and raw-job modes neither detaches to the main PTY nor submits `/termia __terminal`.
9. The interaction UI closes after no waiting job remains and Pi's TUI starts exactly once for each stop.

- [ ] **Step 5: Run RED**

Run:

```bash
node --test --test-name-pattern='automatically handles multiple interactive Agent jobs|ignores Ctrl\+\] during Agent interaction' test/terminal.test.ts test/bang-editor.test.ts
```

Expected: FAIL because waiting events do not yet open UI or foreground jobs.

- [ ] **Step 6: Bind the session UI without adding a global shortcut**

At the start of the existing `session_start` handler, bind the live UI:

```ts
state.terminal.setUi(ctx.ui);
```

Add the matching controller state and setter:

```ts
private ui: ExtensionUIContext | undefined;

setUi(ui: ExtensionUIContext | undefined): void {
  this.ui = ui;
}
```

Clear it with `state.terminal.setUi(undefined)` during final `session_shutdown`/`dispose`. Do not call `ctx.ui.onTerminalInput()` and do not change `BangEditor.handleInput()`.

- [ ] **Step 7: Implement the single-flight interaction loop**

Add one promise guard:

```ts
private agentInteraction: Promise<void> | undefined;

private scheduleAgentInteraction(): void {
  if (this.agentInteraction !== undefined || this.ui === undefined) return;
  if (!this.waitingAgentJobs().length) return;
  this.agentInteraction = this.runAgentInteraction()
    .finally(() => {
      this.agentInteraction = undefined;
      if (this.waitingAgentJobs().length > 0) this.scheduleAgentInteraction();
    });
}
```

`runAgentInteraction()` must:

- Directly select the sole waiting job or open `AgentJobSelector` for multiple jobs.
- Invoke `__termia_agent_foreground <id>` through the hidden control queue.
- Open a `ui.custom()` raw component using the same idempotent TUI stop/start structure as `TerminalController.enter()`.
- Stream already-captured transcript bytes before live bytes.
- Forward ordinary stdin directly with `this.pty?.write(data)`; do not call public `write()` because that marks manual history.
- Consume byte `0x1d` (`Ctrl+]`) without action.
- On byte `0x07` (`Ctrl+G`), set `menuRequested`, write `\x1a` to suspend the selected foreground group, and wait for `agentJobBackground`.
- After a menu request, queue `__termia_agent_background <id>` once the parent shell is ready, then reopen the selector if another job waits.
- Finish automatically on `agentJobEnd`; do not require a keypress.

- [ ] **Step 8: Run GREEN**

Run:

```bash
node --test test/agent-job-ui.test.ts test/bang-editor.test.ts test/terminal.test.ts test/pty-bash.test.ts
npm run typecheck
```

Expected: selector, automatic takeover, two rounds of input per job, job switching, idle-only `Ctrl+]`, single-flight UI, and all earlier terminal tests pass.

- [ ] **Step 9: Commit**

```bash
git add extensions/termia/agent-job-ui.ts extensions/termia/terminal.ts extensions/termia/index.ts test/agent-job-ui.test.ts test/terminal.test.ts test/bang-editor.test.ts
git commit -m "feat: handle interactive Agent jobs automatically"
```

---

### Task 5: Nested SSH regression, documentation, and full verification

**Files:**
- Modify: `test/ssh-integration.test.ts`
- Modify: `README.md`

**Interfaces:**
- Verifies the completed behavior through the existing `local -> A -> B -> C` fixture.
- Documents only user-visible behavior; no release/version changes.

- [ ] **Step 1: Add the nested SSH regression**

In the gated integration fixture, after reaching C:

1. Define an unexported variable and function in C's active shell.
2. Run two Agent Bash calls concurrently and verify both see the variable/function and C's cwd.
3. Verify child `cd` does not move the human C shell.
4. Run one two-prompt `read` command, feed both answers through automatic interaction, and assert its output.
5. Query `HistoryStore` and assert none of the Agent commands or prompt/output strings appear.
6. Run one `!printf` command and assert it still appears under C's SSH workspace URI.

Skip only through the existing `TERMIA_SSH_INTEGRATION` gate; do not add a second environment flag.

- [ ] **Step 2: Update README semantics**

Replace the current statements that ordinary Agent Bash is recorded with this behavior:

```text
While Termia mode is enabled, ordinary Agent bash runs as an isolated background
subshell forked by the current Termia shell. It inherits that shell's cwd,
variables, functions, aliases, options, and virtual-environment state at launch,
but its mutations do not change the parent shell. Multiple non-interactive Agent
commands may run concurrently. Agent bash commands and output are not written to
/termia-history.

If an Agent command needs terminal input, Termia automatically opens an
interactive-job view while Pi waits for tool results. One waiting job opens
directly; multiple jobs show a selector. Input remains attached for repeated
password or y/n prompts. Ctrl+G returns to the job selector. Ctrl+] remains the
idle-only Agent/main-PTY switch and is unavailable while the Agent is running.
Use the main /termia PTY for full-screen programs such as vim, top, and less.
```

Update Quick start, quick-ask Bash behavior, Managed SSH workspaces, Limits, and Storage. Document `/tmp/termia-agent-<shell-id>/` as ephemeral and deleted after job settlement.

- [ ] **Step 3: Run the complete local verification**

Run:

```bash
npm test
npm run typecheck
bash -n extensions/termia/shell/termia-agent.sh extensions/termia/shell/termia.bash extensions/termia/shell/termia-ssh.sh
zsh -n extensions/termia/shell/termia-agent.sh extensions/termia/shell/termia.zsh
busybox ash -n extensions/termia/shell/termia-agent.sh extensions/termia/shell/termia.ash
git diff --check
npm pack --dry-run --json
```

Expected: all tests/typecheck/syntax checks pass, `git diff --check` prints nothing, and dry-run packaging includes `termia-agent.sh` through the existing `extensions` directory.

- [ ] **Step 4: Run gated SSH verification when fixture prerequisites are present**

Run:

```bash
TERMIA_SSH_INTEGRATION=1 node --test test/ssh-integration.test.ts
```

Expected: local -> A -> B -> C, exact shell inheritance, concurrent Agent jobs, repeated interaction, history isolation, mount failure, and disconnect tests all pass.

- [ ] **Step 5: Review the final diff for scope**

Run:

```bash
git status --short
git diff --stat
git diff -- README.md extensions/termia test
```

Expected: only the files listed in this plan plus the approved spec/plan docs changed; no package version, lockfile, generated archive, or unrelated source is present.

- [ ] **Step 6: Commit**

```bash
git add README.md test/ssh-integration.test.ts
git commit -m "docs: describe interactive Agent Bash jobs"
```
