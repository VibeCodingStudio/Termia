# Active Workspace Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one transactional `ActiveWorkspace` module the sole authority for Agent-visible workspace identity, file routing, detached Bash, availability, and terminal-to-Pi activation, while adding an explicit atomic `/termia reset` recovery path.

**Architecture:** `ActiveWorkspace` owns the `SshChain` and exposes a narrow capability object to Pi-facing code plus a separate terminal-fact input facet to `TerminalController`. `PiWorkspaceAdapter` owns Pi hooks, tool registration, presentation, and session handoff; it commits a prepared workspace only after the handoff succeeds. `TerminalReset` stages a fresh local terminal/workspace runtime and swaps it in only after the Pi handoff returns successfully.

**Tech Stack:** TypeScript ESM, Node.js 22 test runner, `@earendil-works/pi-coding-agent`, `node-pty`, SSH/sshfs adapters, npm, Git.

## Global Constraints

- Work from an isolated worktree created with `superpowers:using-git-worktrees`; the current `main` already contains the approved design commit.
- Use `superpowers:test-driven-development` for Tasks 1–7, `superpowers:systematic-debugging` for any unexpected failure, and `superpowers:verification-before-completion` before every completion claim.
- Follow strict TDD for every behavior change: write one focused failing test, run it and confirm the expected failure, implement only enough to pass, then run the focused suite again.
- Keep normal terminal entry, bang execution, history, editor-draft, session forking, and mode toggle behavior unchanged unless this plan explicitly changes a workspace transition.
- Never mutate the Active Workspace before `handoffSession()` succeeds. A cancelled or failed handoff must leave the previous Active Workspace unchanged and retain the candidate as Pending.
- Never recover by selecting a nearest live ancestor. Only an observed terminal close event may make an ancestor a new candidate.
- An unavailable remote Active Workspace keeps its logical `ssh://` identity. Remote-relative file operations and Agent Bash fail closed; local absolute file paths remain available.
- Do not add automatic SSH reconnect, workspace persistence across Pi restarts, generic reconnect UI, or changes to the terminal protocol.
- Use the exact terms `Active Workspace`, `Pending Workspace`, and `Terminal Reset` in new code comments, tests, messages, and documentation.
- Preserve the public behavior frozen in [the approved design](../specs/2026-07-25-active-workspace-routing-design.md) and the project vocabulary in [`CONTEXT.md`](../../../CONTEXT.md).
- After each task, run its focused tests, `npm run typecheck`, inspect `git diff --check`, and create the specified narrow commit.

---

## File Structure

### Create

- `extensions/termia/active-workspace.ts` — deep module that owns Active/Pending state, generation checks, `SshChain`, path routing, detached Bash, presentation, and the terminal-fact input facet.
- `extensions/termia/pi-workspace.ts` — Pi-specific adapter for tool hooks, Bash registration, prompt/title presentation, notifications, and prepare/handoff/commit ordering.
- `extensions/termia/terminal-reset.ts` — staged Terminal Reset transaction with confirmation, handoff, atomic replacement, and rollback cleanup.
- `test/active-workspace.test.ts` — public-interface tests for activation, stale tickets, path/Bash routing, presentation, and availability.
- `test/pi-workspace.test.ts` — fake-Pi tests for hook ownership, handoff ordering, cancellation, Pending messages, and title state.
- `test/terminal-reset.test.ts` — reset transaction ordering and rollback tests.

### Modify

- `extensions/termia/terminal.ts` — accept a `TerminalWorkspaceFeed`; forward protocol facts and stop exposing raw workspace policy.
- `extensions/termia/index.ts` — compose the runtime, install `PiWorkspaceAdapter`, remove duplicated `binding`/`piCwd`, remove nearest-live recovery, and dispatch `/termia reset`.
- `extensions/termia/workspace.ts` — retain internal binding/path/presentation helpers, remove caller-facing tool-policy ownership, and reduce exports after migration.
- `test/terminal.test.ts` — construct the controller with the terminal facet and remove private-reducer workspace assertions now covered through `ActiveWorkspace`.
- `README.md` — document Active/Pending behavior, unavailable behavior, and the destructive-but-atomic Reset flow.

### Delete after replacements pass

- `extensions/termia/pty-bash.ts` — delete during the Task 5 authority cutover after Bash ownership has moved into `WorkspaceAccess.runDetached()`.
- `test/pty-bash.test.ts` — delete with its Task 5 module after behavior has moved to `test/active-workspace.test.ts`.
- `test/workspace-tools.test.ts` — behavior moves to `test/active-workspace.test.ts` and `test/pi-workspace.test.ts`.
- `test/workspace.test.ts` — logical routing and presentation move behind the `WorkspaceAccess` interface.

### Preserve as adapter-contract suites

- `test/ssh-workspace.test.ts`
- `test/protocol.test.ts`
- `test/session.test.ts`
- Shell integration tests under `test/*.test.sh` and their Node wrappers.

---

## Task 1: Add the transactional Active Workspace core

**Files:**

- Create: `extensions/termia/active-workspace.ts`
- Create: `test/active-workspace.test.ts`
- Reference: `extensions/termia/ssh-workspace.ts`
- Reference: `extensions/termia/workspace.ts`

### Interfaces to establish

`active-workspace.ts` must export only the following caller-facing contracts and factory; keep the implementing class private:

```ts
import type { IdentityOpenEvent, SshOpenEvent } from "./protocol.ts";
import type {
  IdentityOperations,
  MountOperations,
  WorkspaceContext,
} from "./ssh-workspace.ts";

export type WorkspaceGeneration = number & { readonly __workspaceGeneration: unique symbol };
export type WorkspaceAvailability =
  | { kind: "available" }
  | { kind: "unavailable"; reason: string };

export type WorkspaceSummary = {
  uri: string;
  generation: WorkspaceGeneration;
  availability: WorkspaceAvailability;
};

export type PendingWorkspaceSummary = {
  uri: string;
  generation: WorkspaceGeneration;
  active: WorkspaceSummary;
  readiness: "ready" | "blocked" | "deferred";
  reason?: string;
};

export class WorkspacePathError extends Error {}
export class WorkspaceUnavailableError extends Error {}
export class StaleWorkspaceAccessError extends Error {}
export class StaleActivationError extends Error {}

export type DetachedCommand = {
  command: string;
  cwd: string;
  options: {
    onData(data: Buffer): void;
    signal?: AbortSignal;
    timeout?: number;
    env?: NodeJS.ProcessEnv;
  };
};

export type DetachedCommandResult = { exitCode: number | null };

export interface DetachedCommandOperations {
  run(input: DetachedCommand): Promise<DetachedCommandResult>;
}

export type AgentPresentation = {
  systemPrompt: string;
  skills: readonly { filePath: string }[];
};

export interface WorkspaceAccess {
  readonly summary: WorkspaceSummary;
  executionDirectory(): string;
  filePath(path: string): string;
  runDetached(input: DetachedCommand): Promise<DetachedCommandResult>;
  present(input: AgentPresentation): AgentPresentation;
}

export type WorkspaceActivation =
  | { kind: "unchanged"; active: WorkspaceSummary }
  | { kind: "pending"; pending: PendingWorkspaceSummary }
  | {
      kind: "ready";
      pending: PendingWorkspaceSummary;
      handoffCwd: string;
      commit(): WorkspaceSummary;
      defer(reason: string): PendingWorkspaceSummary;
    };

export interface ActiveWorkspace extends AsyncDisposable {
  current(): WorkspaceAccess;
  prepare(shellId: string): Promise<WorkspaceActivation>;
}

export interface TerminalWorkspaceFeed {
  resetRoot(cwd: string, shellId: string): void;
  openSsh(event: SshOpenEvent): void;
  openIdentity(event: IdentityOpenEvent, privateKey: string): void;
  updateCwd(shellId: string, cwd: string): void;
  close(shellId: string): Promise<void>;
  contextFor(shellId: string, cwd?: string): WorkspaceContext;
  localCwd(): string;
  terminalExited(): Promise<void>;
}

export function createActiveWorkspace(
  cwd: string,
  detached: DetachedCommandOperations,
  mounts?: MountOperations,
  identities?: IdentityOperations,
): { workspace: ActiveWorkspace; terminal: TerminalWorkspaceFeed };
```

### Steps

- [ ] **Step 1: Write the first failing activation tests**

Add tests that use the factory's public facets—never `Reflect` or the private implementation—to prove local initialization, Pending isolation, commit, defer/retry, and stale-ticket rejection:

```ts
test("keeps Active unchanged until a prepared SSH workspace commits", async (t) => {
  const mounts = new MemoryMounts();
  const { workspace, terminal } = createActiveWorkspace("/work/project", fakeDetached(), mounts);
  t.after(() => workspace[Symbol.asyncDispose]());
  terminal.resetRoot("/work/project", "local");
  terminal.openSsh(sshOpen("remote", "local", "/srv/app"));

  const activation = await workspace.prepare("remote");
  assert.equal(activation.kind, "ready");
  assert.equal(workspace.current().summary.uri, "file:///work/project");
  assert.equal(activation.pending.uri, "ssh://klein@server/srv/app");

  const committed = activation.commit();
  assert.equal(committed.uri, "ssh://klein@server/srv/app");
  assert.equal(workspace.current().summary.uri, "ssh://klein@server/srv/app");
});

test("retains a deferred candidate as Pending without changing Active", async (t) => {
  const { workspace, terminal } = createActiveWorkspace("/work/project", fakeDetached(), new MemoryMounts());
  t.after(() => workspace[Symbol.asyncDispose]());
  terminal.resetRoot("/work/project", "local");
  terminal.openSsh(sshOpen("remote", "local", "/srv/app"));

  const first = await workspace.prepare("remote");
  assert.equal(first.kind, "ready");
  first.defer("Pi session handoff was cancelled");
  assert.equal(workspace.current().summary.uri, "file:///work/project");

  const retry = await workspace.prepare("remote");
  assert.equal(retry.kind, "ready");
  assert.equal(retry.pending.uri, "ssh://klein@server/srv/app");
});

test("rejects a ready ticket after terminal topology changes", async (t) => {
  const { workspace, terminal } = createActiveWorkspace("/work/project", fakeDetached(), new MemoryMounts());
  t.after(() => workspace[Symbol.asyncDispose]());
  terminal.resetRoot("/work/project", "local");
  terminal.openSsh(sshOpen("remote", "local", "/srv/app"));
  const activation = await workspace.prepare("remote");
  assert.equal(activation.kind, "ready");

  terminal.updateCwd("remote", "/srv/other");
  assert.throws(() => activation.commit(), /stale Active Workspace activation/);
  assert.equal(workspace.current().summary.uri, "file:///work/project");
});
```

Define deterministic `MemoryMounts`, `MemoryIdentities`, `fakeDetached()`, and `sshOpen()` fixtures in this test file. `fakeDetached().run()` must preserve the supplied stream, signal, timeout, and env fields. `MemoryMounts.mount()` must return `sshWorkspace(hops, cwd, "/tmp/termia-test-mount")`, expose a per-shell health flag, and count unmounts.

- [ ] **Step 2: Run the focused test and verify the expected failure**

Run:

```bash
node --test test/active-workspace.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `extensions/termia/active-workspace.ts`.

- [ ] **Step 3: Implement the private state machine and two facets**

Implement one private `ActiveWorkspaceState` that owns:

```ts
type Candidate = {
  shellId: string;
  binding: WorkspaceBinding;
  topologyRevision: number;
  summary: PendingWorkspaceSummary;
  deferredReason?: string;
};

class ActiveWorkspaceState {
  private readonly chain: SshChain;
  private active: WorkspaceBinding;
  private activeAvailability: WorkspaceAvailability = { kind: "available" };
  private generation = 1;
  private topologyRevision = 1;
  private pending: Candidate | undefined;
  private disposed = false;
}
```

Apply these rules in the implementation:

1. `current()` refreshes Active health, increments `generation` only when availability changes, and returns a generation-bound capability.
2. `prepare(shellId)` awaits `SshChain.readyBinding(shellId)`. A route/mount error returns `kind: "pending"` with a blocked Pending summary whose logical URI comes from `chain.contextFor(shellId)` and whose `active` field snapshots the unchanged Active Workspace.
3. Equal logical URI plus equal physical execution directory returns `kind: "unchanged"`.
4. A ready ticket captures `topologyRevision`; its single-use `commit()` throws `StaleActivationError` when consumed or stale, then atomically installs the candidate, clears Pending, increments generation, and returns the new `WorkspaceSummary`.
5. `defer(reason)` records the reason and keeps the candidate retryable. It never changes Active.
6. Every `openSsh`, `openIdentity`, `updateCwd`, `close`, `resetRoot`, and `terminalExited` event increments `topologyRevision`, invalidating older tickets.
7. `close(shellId)` changes only terminal topology. It never promotes an ancestor into Active; a later `prepare(parentShellId)` is required.
8. `terminalExited()` disposes route resources but preserves a remote Active identity as unavailable.
9. `[Symbol.asyncDispose]()` is idempotent and disposes the internal `SshChain` exactly once.

Use the existing `fileWorkspace()`, `workspaceUri()`, and `SshChain` rather than duplicating their parsing or lifecycle rules.

- [ ] **Step 4: Add failure and real-close tests**

Add four focused tests using the fixtures from Step 1; do not test private fields:

- `reports a failed mount as Pending and preserves Active`: make `MemoryMounts.mount()` reject for shell `remote`, assert `prepare("remote")` returns Pending with `ssh://klein@server/srv/app`, assert the reason includes the injected mount error, and re-read Active as `file:///work/project`.
- `does not promote an ancestor until its real close event is observed`: commit a nested leaf, mark it unhealthy, assert Active retains the leaf URI as unavailable, call `close("leaf")`, then assert Active still retains that URI until `prepare("parent")` is explicitly committed.
- `makes a remote Active unavailable when the terminal exits`: commit `remote`, call `terminalExited()`, and assert the same `ssh://klein@server/srv/app` URI with `{ kind: "unavailable" }`.
- `disposes route resources exactly once`: call `[Symbol.asyncDispose]()` twice and assert each mounted shell and identity is released exactly once.

- [ ] **Step 5: Run focused verification**

Run:

```bash
node --test test/active-workspace.test.ts
npm run typecheck
git diff --check
```

Expected: all Active Workspace tests pass, TypeScript exits 0, and `git diff --check` prints nothing.

- [ ] **Step 6: Commit the core**

```bash
git add extensions/termia/active-workspace.ts test/active-workspace.test.ts
git commit -m "feat: add transactional active workspace core"
```

---

## Task 2: Move file routing, presentation, availability, and detached Bash behind WorkspaceAccess

**Files:**

- Modify: `extensions/termia/active-workspace.ts`
- Modify: `test/active-workspace.test.ts`
- Reference: `extensions/termia/workspace.ts`
- Reference: `extensions/termia/pty-bash.ts`
- Reference: `test/pty-bash.test.ts`
- Reference: `test/workspace-tools.test.ts`
- Reference: `test/workspace.test.ts`

### Steps

- [ ] **Step 1: Write failing capability tests**

Port the existing routing assertions through `WorkspaceAccess` and add generation/availability assertions:

```ts
test("routes all Agent-visible file paths through the committed access", async (t) => {
  const harness = await activeRemote("/srv/app");
  t.after(harness.dispose);
  const access = harness.workspace.current();

  assert.equal(access.filePath("src/index.ts"), "src/index.ts");
  assert.equal(access.filePath("/etc/hosts"), "/etc/hosts");
  assert.equal(
    access.filePath("ssh://klein@server/etc/hosts"),
    "/tmp/termia-test-mount/etc/hosts",
  );
  assert.throws(() => access.filePath("~/.ssh/config"), /cannot map ~ paths safely/);
  assert.throws(() => access.filePath("ssh://other@server/etc/hosts"), /does not match/);
});

test("fails closed for remote capabilities but permits local absolute files", async (t) => {
  const harness = await activeRemote("/srv/app");
  t.after(harness.dispose);
  const old = harness.workspace.current();
  harness.mounts.setHealthy("remote", false);
  const unavailable = harness.workspace.current();

  assert.equal(unavailable.summary.uri, "ssh://klein@server/srv/app");
  assert.equal(unavailable.summary.availability.kind, "unavailable");
  assert.notEqual(unavailable.summary.generation, old.summary.generation);
  assert.equal(unavailable.filePath("/home/klein/local.txt"), "/home/klein/local.txt");
  assert.throws(() => unavailable.filePath("src/index.ts"), /Active Workspace.*unavailable/);
  await assert.rejects(
    unavailable.runDetached({
      command: "pwd",
      cwd: unavailable.executionDirectory(),
      options: { onData: () => {} },
    }),
    /Active Workspace.*unavailable/,
  );
  assert.throws(() => old.executionDirectory(), /stale Active Workspace access/);
});
```

Also port the existing prompt-presentation test and detached Bash cases with these exact assertions:

- `delegates remote Bash through an encoded SSH command`: execute `printf 'hello'\nread value`, assert exit code/output/timeout are preserved, delegated cwd is the physical mount path, delegated command contains `ssh -T -S` and `/srv/app`, and it does not contain plaintext `read value`.
- `keeps local detached Bash concurrency, abort, timeout, and no-PTY semantics`: retain all four assertions from `pty-bash.test.ts`, including independent concurrent cancellation and a successful command after timeout.
- `presents logical SSH cwd and remote skill paths without exposing mount roots`: retain the exact local-skill, remote-skill, relative-path guidance, `ssh://` cwd, and no-`/tmp/mount-b` assertions from `workspace.test.ts`, but assert `access.present({ systemPrompt, skills }).systemPrompt` and that the returned skills array is unchanged.

- [ ] **Step 2: Run the focused tests and verify the expected failures**

Run:

```bash
node --test --test-name-pattern="routes all|fails closed|delegates remote|keeps local detached|presents logical" test/active-workspace.test.ts
```

Expected: FAIL because the Task 1 capability methods do not yet enforce generation-bound health and Bash routing.

- [ ] **Step 3: Implement generation-bound capabilities**

Inside the private state, create access objects that capture the current generation and binding. Every method must call a common guard before touching remote state:

```ts
private assertCurrent(captured: WorkspaceGeneration): void {
  this.refreshAvailability();
  if (captured !== this.asGeneration()) {
    throw new StaleWorkspaceAccessError(
      `Termia rejected stale Active Workspace access for ${this.activeSummary().uri}; retry the operation`,
    );
  }
}
```

Implement the capability methods with these exact ownership rules:

- `executionDirectory()` returns the committed binding's physical `piCwd` only after the generation guard.
- `filePath(input)` keeps local absolute paths local even while remote Active is unavailable; it rejects every path that would traverse the unavailable remote mount, including relative and explicit `ssh://` paths; otherwise it delegates to `projectWorkspacePath()`. Normalize invalid URI, NUL, tilde, and mismatched-host failures into `WorkspacePathError` without losing the original message.
- `runDetached(input)` validates that `input.cwd` is the committed physical workspace. Local Active delegates the original `DetachedCommand`. Remote Active replaces only `input.command` with `buildRemoteBashCommand(binding.target.hops, binding.target.path, input.command)` and delegates to the injected `DetachedCommandOperations` with physical cwd and unchanged options.
- `present(input)` returns a copy of `AgentPresentation` whose `systemPrompt` delegates to `presentWorkspaceCwd(input.systemPrompt, binding, input.skills)` for both available and unavailable remote state. Logical identity presentation does not touch the remote mount and never replaces the URI with an ancestor.
- `refreshAvailability()` derives health from `SshChain.isHealthy(active)`. It changes generation only when `{kind, reason}` changes.

Use `WorkspaceUnavailableError` with one actionable remote-unavailable message everywhere:

```ts
function unavailableMessage(summary: WorkspaceSummary): string {
  const detail = summary.availability.kind === "unavailable"
    ? `: ${summary.availability.reason}`
    : "";
  return `Termia Active Workspace ${summary.uri} is unavailable${detail}; close the failed SSH hop in the terminal or run /termia reset`;
}
```

- [ ] **Step 4: Preserve the legacy caller until runtime migration**

Keep `FILE_TOOLS`, `WORKSPACE_TOOLS`, `DISCONNECTED_REASON`, and `applyWorkspaceToolPolicy()` temporarily because `index.ts` and the old replacement tests still import them. Do not add new callers. Task 5 removes the runtime caller; Task 7 deletes the compatibility function and its tests after the replacement suites are green.

Likewise, do not delete the old test files or `pty-bash.ts` yet; Task 5 deletes the Bash wrapper/tests at the authority cutover, and Task 7 deletes the remaining legacy workspace tests after all new integration tests pass.

- [ ] **Step 5: Run the replacement and regression suites**

Run:

```bash
node --test test/active-workspace.test.ts test/ssh-workspace.test.ts
node --test test/pty-bash.test.ts test/workspace.test.ts
npm run typecheck
git diff --check
```

Expected: new capability tests pass. The old tests may still pass because their legacy modules remain until Task 7; TypeScript exits 0.

- [ ] **Step 6: Commit the deepened capability interface**

```bash
git add extensions/termia/active-workspace.ts test/active-workspace.test.ts
git commit -m "refactor: deepen active workspace capabilities"
```

---

## Task 3: Shadow-publish terminal facts before the authority cutover

**Files:**

- Modify: `extensions/termia/terminal.ts`
- Modify: `test/terminal.test.ts`
- Modify: `test/active-workspace.test.ts`
- Modify: `test/history.test.ts`

### Steps

- [ ] **Step 1: Add a failing terminal-to-workspace integration test**

Add one public-behavior test to `test/terminal.test.ts` that constructs both facets, starts a real supported shell, drives a cwd-changing command, and asserts the fact reached `ActiveWorkspace` through `prepare()`:

```ts
test("publishes shell workspace facts through TerminalWorkspaceFeed", async (t) => {
  const harness = createTerminalHarness(t);
  mkdirSync(join(harness.cwd, "child"));
  harness.terminal.start(harness.cwd, "/bin/bash");
  await harness.terminal.execute("cd child");
  const record = harness.history.listCompletedCommands(1)[0]!;

  const activation = await harness.workspace.prepare(record.shellId);
  assert.equal(activation.kind, "ready");
  assert.equal(activation.pending.uri, pathToFileURL(join(harness.cwd, "child")).href);
  assert.equal(harness.workspace.current().summary.uri, pathToFileURL(harness.cwd).href);
});
```

Update the shared test harness to create:

```ts
const local = createLocalBashOperations();
const facets = createActiveWorkspace(
  cwd,
  {
    run: ({ command, cwd: commandCwd, options }) =>
      local.exec(command, commandCwd, options),
  },
  mounts,
  identities,
);
const terminal = new TerminalController(history, undefined, undefined, facets.terminal);
```

Do not make `TerminalController` construct a default Active Workspace; the omitted shadow feed means “no shadow publication,” not hidden ownership of a second new core.

- [ ] **Step 2: Run the focused test and verify the constructor mismatch**

Run:

```bash
node --test --test-name-pattern="publishes shell workspace facts" test/terminal.test.ts
```

Expected: FAIL because the fourth argument is ignored, so the new core never receives the real terminal id/cwd facts and `prepare(record.shellId)` cannot resolve the shell.

- [ ] **Step 3: Add the bounded shadow-publishing bridge**

Add an optional last constructor dependency and field:

```ts
private readonly shadowWorkspaces: TerminalWorkspaceFeed | undefined;

constructor(
  history: HistoryStore,
  mounts?: MountOperations,
  identities?: IdentityOperations,
  shadowWorkspaces?: TerminalWorkspaceFeed,
) {
  this.history = history;
  this.sshChain = new SshChain(fileWorkspace(process.cwd()), "local", mounts, identities);
  this.shadowWorkspaces = shadowWorkspaces;
}
```

Keep existing `SshChain` calls intact for this one migration commit, and shadow-publish the same facts with a one-to-one mapping:

| Terminal event | `TerminalWorkspaceFeed` call |
|---|---|
| `start(cwd)` | `resetRoot(cwd, terminalId)` |
| `ready`, `end`, `observed` | `updateCwd(shellId, cwd)` |
| `sshOpen` | `openSsh(token)` |
| `identityOpen` | `openIdentity(token, privateKey)` |
| `sshClose` | `close(shellId)` |
| PTY finish/dispose | `terminalExited()` |

The bridge is intentionally temporary: `SshChain` remains the live authority so `index.ts` and existing tests stay green, while the new core receives identical facts for comparison. Do not use shadow state for decisions in this task. Task 5 flips authority and deletes the old field and public policy methods in the same green commit.

Keep PTY lifecycle, parser, history, explicit execution, attach/detach, identity credential creation, and every public controller method unchanged in this task.

- [ ] **Step 4: Add public Pending-history provenance coverage**

Add a public history-provenance test to `test/history.test.ts`: construct an Active Workspace with local Active, publish a remote shell through `TerminalWorkspaceFeed`, persist a command with `history.startCommand(event, terminal.contextFor("remote", "/srv/pending"))`, finish it, and assert the record URI is `ssh://klein@server/srv/pending` while `workspace.current().summary.uri` remains the local URI. This preserves the design rule that commands are attributed to the terminal environment where they actually ran, even while Agent tools stay in the previous Active Workspace.

- [ ] **Step 5: Wire the shadow facet only in the new integration harness**

Pass `facets.terminal` as the fourth constructor argument in the new integration test. Existing callers remain unchanged until the Task 5 cutover. Ensure the new test disposes both controller and `ActiveWorkspace`:

```ts
t.after(async () => {
  terminal.dispose();
  await workspace[Symbol.asyncDispose]();
  history.close();
});
```

- [ ] **Step 6: Run controller and core verification**

Run:

```bash
node --test test/terminal.test.ts test/active-workspace.test.ts test/history.test.ts test/protocol.test.ts
npm run typecheck
git diff --check
```

Expected: all tests and TypeScript pass. Audit the bounded bridge with:

```bash
rg "shadowWorkspaces\?\.(resetRoot|openSsh|openIdentity|updateCwd|close|terminalExited)" extensions/termia/terminal.ts
```

Expected: every terminal fact appears in the bridge. The old `SshChain` methods still exist only until Task 5.

- [ ] **Step 7: Commit the shadow bridge**

```bash
git add extensions/termia/terminal.ts test/terminal.test.ts test/active-workspace.test.ts test/history.test.ts
git commit -m "refactor: shadow-publish terminal workspace facts"
```

---

## Task 4: Add the Pi Workspace adapter and enforce handoff-before-commit

**Files:**

- Create: `extensions/termia/pi-workspace.ts`
- Create: `test/pi-workspace.test.ts`
- Reference: `extensions/termia/session.ts`
- Reference: `extensions/termia/index.ts`

### Interfaces to establish

```ts
import type {
  BashOperations,
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { ActiveWorkspace } from "./active-workspace.ts";
import type { SessionTransitionOptions } from "./session.ts";

export type WorkspaceActivationResult = "unchanged" | "committed" | "pending" | "cancelled";

export interface PiWorkspaceAdapter {
  activate(
    ctx: ExtensionCommandContext,
    shellId: string,
    options?: SessionTransitionOptions,
  ): Promise<WorkspaceActivationResult>;
  show(ctx: Pick<ExtensionCommandContext, "ui">): void;
}

export function installPiWorkspaceAdapter(options: {
  pi: ExtensionAPI;
  workspace: () => ActiveWorkspace;
  enabled: () => boolean;
  localBash: BashOperations;
  root: string;
  handoff?: typeof import("./session.ts").handoffSession;
}): PiWorkspaceAdapter;
```

The `workspace` getter is deliberate: Terminal Reset will atomically replace the core runtime without registering a second set of Pi hooks.

### Steps

- [ ] **Step 1: Write failing fake-Pi tests for exclusive hook ownership**

Create a small fake `ExtensionAPI` that records `registerTool()` calls and `on()` handlers. Test the adapter through registered handlers and its public methods:

```ts
test("routes file tools and Bash through one current WorkspaceAccess", async () => {
  const access = fakeAccess({ uri: "ssh://klein@server/srv/app" });
  const pi = fakePi();
  installPiWorkspaceAdapter({
    pi: pi.api,
    workspace: () => fakeWorkspace(access),
    enabled: () => true,
    localBash: fakeBash(),
    root: "/tmp/termia",
  });

  const read = { toolName: "read", input: { path: "src/index.ts" } };
  await pi.emit("tool_call", read);
  assert.equal(read.input.path, "/mapped/src/index.ts");

  await pi.bash.exec("pwd", "/physical/srv/app", { onData: () => {} });
  assert.deepEqual(access.calls, ["file:src/index.ts", "bash:pwd:/physical/srv/app"]);
});

test("commits only after a successful Pi handoff", async () => {
  const order: string[] = [];
  const activation = readyActivation(order);
  const adapter = installPiWorkspaceAdapter({
    pi: fakePi().api,
    workspace: () => fakeWorkspaceWithActivation(activation),
    enabled: () => true,
    localBash: fakeBash(),
    root: "/tmp/termia",
    handoff: async (_ctx, cwd, _root, options) => {
      order.push(`handoff:${cwd}`);
      await options?.withSession?.(fakeCommandContext());
      order.push("handoff-complete");
      return { cancelled: false, switched: true };
    },
  });

  assert.equal(await adapter.activate(fakeCommandContext(), "remote"), "committed");
  assert.deepEqual(order, ["handoff:/physical/srv/app", "handoff-complete", "commit"]);
});
```

Add companion tests that prove:

- cancelled handoff calls `defer()` but never `commit()`;
- thrown handoff calls `defer()` and rethrows;
- Pending emits one warning containing both Pending and Active URIs;
- unavailable Active title is exactly `Termia — ssh://klein@server/srv/app · unavailable`;
- `before_agent_start` uses `access.present()`;
- local absolute file paths are not blocked when remote Active is unavailable;
- enabled=false delegates Bash to `localBash` and leaves file hooks untouched.

- [ ] **Step 2: Run the adapter suite and verify the missing module failure**

Run:

```bash
node --test test/pi-workspace.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `extensions/termia/pi-workspace.ts`.

- [ ] **Step 3: Implement one Pi-facing owner for workspace behavior**

In `installPiWorkspaceAdapter()`:

1. Register the Bash tool exactly once with `createBashToolDefinition(workspace().current().executionDirectory(), { operations, spawnHook })`.
2. Its operations call `workspace().current().runDetached({ command, cwd, options: execOptions })` when enabled and `localBash.exec(command, cwd, execOptions)` when disabled.
3. Its spawn hook reads a fresh access and replaces `cwd` with `executionDirectory()` when enabled.
4. Register exactly one `tool_call` handler for `read`, `edit`, `write`, `grep`, `find`, `ls`, and `bash`. File tools rewrite `event.input.path` through `access.filePath()`. For Bash, return `{ block: true, reason }` when `access.summary.availability.kind === "unavailable"`; `runDetached()` repeats the fail-closed check at execution time. Convert capability exceptions to `{ block: true, reason }`; non-workspace tools pass untouched.
5. Register exactly one `before_agent_start` handler that calls `access.present({ systemPrompt: event.systemPrompt, skills: event.systemPromptOptions.skills })` and returns its `systemPrompt` while enabled.
6. `show()` reads a fresh summary and sets the exact available/unavailable title.
7. Do not import `WorkspaceBinding`, `SshChain`, `MountOperations`, `IdentityOperations`, or inspect `target.scheme` in this file.

- [ ] **Step 4: Implement atomic activation and notifications**

`activate()` must follow this sequence:

```ts
const prepared = await workspace().prepare(shellId);
if (prepared.kind === "unchanged") {
  adapter.show(ctx);
  return "unchanged";
}
if (prepared.kind === "pending") {
  ctx.ui.notify(
    [
      `Pending workspace: ${prepared.pending.uri}`,
      `Mount unavailable: ${prepared.pending.reason ?? "unknown error"}`,
      `Agent remains in ${prepared.pending.active.uri}`,
    ].join("\n"),
    "warning",
  );
  return "pending";
}

let committed = false;
let replacementCtx: ExtensionCommandContext | undefined;
try {
  const result = await handoff(ctx, prepared.handoffCwd, root, {
    ...options,
    withSession: async (nextCtx) => {
      replacementCtx = nextCtx;
      await options?.withSession?.(nextCtx);
    },
  });
  if (result.cancelled) {
    prepared.defer("Pi session handoff was cancelled");
    ctx.ui.notify("Termia workspace handoff was cancelled; previous Active Workspace retained", "warning");
    return "cancelled";
  }
  prepared.commit();
  committed = true;
  adapter.show(replacementCtx ?? ctx);
  return "committed";
} catch (error) {
  if (!committed) {
    try {
      prepared.defer(errorMessage(error));
    } catch (deferError) {
      if (!(deferError instanceof StaleActivationError)) throw deferError;
    }
  }
  throw error;
}
```

The wrapper deliberately captures the replacement context but commits only after `handoffSession()` returns successfully. If `options.withSession` or the session switch throws, `defer()` runs and the previous Active Workspace remains unchanged. Add a test that makes `options.withSession` throw and asserts that `commit()` was never called.

- [ ] **Step 5: Run adapter, session, and type verification**

Run:

```bash
node --test test/pi-workspace.test.ts test/session.test.ts test/active-workspace.test.ts
npm run typecheck
git diff --check
```

Expected: all pass; `rg "WorkspaceBinding|SshChain|target\.scheme|mountRoot|hops" extensions/termia/pi-workspace.ts` prints no matches.

- [ ] **Step 6: Commit the adapter**

```bash
git add extensions/termia/pi-workspace.ts test/pi-workspace.test.ts
git commit -m "feat: add Pi active workspace adapter"
```

---

## Task 5: Migrate the extension runtime to the new seams

**Files:**

- Modify: `extensions/termia/index.ts`
- Modify: `extensions/termia/terminal.ts`
- Modify: `test/active-workspace.test.ts`
- Modify: `test/pi-workspace.test.ts`
- Modify: `test/terminal.test.ts`
- Delete: `extensions/termia/pty-bash.ts`
- Delete: `test/pty-bash.test.ts`

### Runtime shape to establish

Replace `binding`, `piCwd`, and the controller-owned workspace with one replaceable runtime:

```ts
type WorkspaceRuntime = {
  workspace: ActiveWorkspace;
  terminalFeed: TerminalWorkspaceFeed;
  terminal: TerminalController;
};

type TermiaRuntime = {
  api: ExtensionAPI | undefined;
  enabled: boolean;
  previousSessionFile: string | undefined;
  shortcutHintShown: boolean;
  editorDraft: string | undefined;
  history: HistoryStore;
  localBash: BashOperations;
  workspaceRuntime: WorkspaceRuntime;
  piWorkspace: PiWorkspaceAdapter | undefined;
  editorFactory: EditorFactory | undefined;
  agentActive: boolean;
};
```

Construct `WorkspaceRuntime` in one local helper so Task 6 can stage the same unit:

```ts
function createWorkspaceRuntime(
  cwd: string,
  history: HistoryStore,
  localBash: BashOperations,
): WorkspaceRuntime {
  const facets = createActiveWorkspace(cwd, {
    run: ({ command, cwd: commandCwd, options }) =>
      localBash.exec(command, commandCwd, options),
  });
  return {
    workspace: facets.workspace,
    terminalFeed: facets.terminal,
    terminal: new TerminalController(history, facets.terminal),
  };
}
```

### Steps

- [ ] **Step 1: Add failing integration assertions around activation ordering**

Extend `test/pi-workspace.test.ts` with the command flows that `index.ts` will use:

- `keeps previous Active when terminal detach activation is cancelled`: return a cancelled handoff, assert `activate()` returns `"cancelled"`, `defer()` receives the cancellation reason, and the previous summary URI is unchanged.
- `keeps a failed candidate Pending for a later terminal retry`: make the first `prepare()` return Pending and the second return Ready for the same URI; assert there is no intermediate commit and the second activation commits only after handoff.
- `a close event requires explicit activation of the parent shell`: begin with an unavailable leaf Active, publish the real leaf close through the terminal facet, and assert the parent becomes Active only after `activate(ctx, parentShellId)`.

These tests should fail against any implementation that commits before handoff or automatically selects an ancestor.

- [ ] **Step 2: Flip TerminalController from shadow publication to the terminal facet**

Replace the temporary `sshChain` and `shadowWorkspaces` fields with one required `TerminalWorkspaceFeed`:

```ts
private readonly workspaces: TerminalWorkspaceFeed;

constructor(history: HistoryStore, workspaces: TerminalWorkspaceFeed) {
  this.history = history;
  this.workspaces = workspaces;
}
```

Replace every legacy `SshChain` use with the mapping proven in Task 3, and switch command-history context calls to `workspaces.contextFor(shellId, cwd)`. Delete these public policy methods: `workspace`, `readyWorkspace()`, `nearestLiveWorkspace()`, `isWorkspaceHealthy()`, `assertWorkspace()`, and `disposeWorkspaces()`.

Update every `new TerminalController(...)` in tests to pass a terminal facet. Remove only the two workspace-specific `Reflect` blocks from `test/terminal.test.ts`; migrate their nested SSH, identity, cwd-update, close-order, and disposal assertions to `test/active-workspace.test.ts`. Keep unrelated private PTY execution tests.

Delete `extensions/termia/pty-bash.ts` and `test/pty-bash.test.ts` now: Task 2 already moved every local/remote detached Bash assertion to `WorkspaceAccess`, and leaving the file would require the raw controller API being removed in this step.

- [ ] **Step 3: Install the adapter once and remove duplicate runtime state**

In `runtime()`:

- create one `localBash = createLocalBashOperations()`;
- create one `workspaceRuntime` with `createWorkspaceRuntime(process.cwd(), history, localBash)`;
- store `localBash` on `TermiaRuntime` so the Pi adapter and every staged Reset runtime share the same detached backend;
- remove `binding` and `piCwd`;
- initialize `piWorkspace` as undefined.

In the extension entrypoint, call `installPiWorkspaceAdapter()` once with getters:

```ts
state.piWorkspace = installPiWorkspaceAdapter({
  pi,
  workspace: () => state.workspaceRuntime.workspace,
  enabled: () => state.enabled,
  localBash: state.localBash,
  root: ROOT,
});
```

Delete the Bash registration, `tool_call`, and `before_agent_start` handlers from `index.ts`; the adapter exclusively owns them.

- [ ] **Step 4: Replace terminal and bang transitions with `activate()`**

Make both flows operate in this order:

1. Start/enter/execute the persistent terminal exactly as today.
2. Obtain the terminal-reported `shellId`.
3. Call `state.piWorkspace.activate(ctx, shellId)`.
4. Let the adapter notify Pending/cancelled outcomes.

Delete `setBinding()`, `handoffWorkspace()`, `restoreTerminalCwd()`, and the automatic block in `enterTerminal()` that calls `nearestLiveWorkspace()`. A cancelled activation must not `cd` the terminal backward; the terminal remains in the Pending Workspace while Agent stays in the previous Active Workspace.

For bang execution, preserve result recording and context injection before activation. Use `outcome.record.shellId` as the candidate shell.

- [ ] **Step 5: Make session and mode lifecycle respect the single authority**

- `showWorkspace()` becomes `state.piWorkspace?.show(ctx)`.
- While Termia is enabled, `session_start` must not rewrite Active Workspace based on `ctx.cwd`; only an activation ticket may do so.
- While disabled, replace the old workspace runtime with a fresh local runtime for `ctx.cwd`, then dispose the old runtime asynchronously.
- On mode disable, stop the terminal, replace with a fresh local runtime rooted at the replacement session cwd, and keep the installed Pi adapter because its workspace getter follows the replacement.
- On quit, dispose the terminal, await/trigger `workspace[Symbol.asyncDispose]()`, close history, and clear the global runtime.
- Preserve History tool synchronization, editor installation, draft restoration, message renderers, and managed-session rules exactly.

Implement one helper and use it from disabled `session_start`, mode disable, and Task 6:

```ts
async function replaceWorkspaceRuntime(
  state: TermiaRuntime,
  next: WorkspaceRuntime,
): Promise<void> {
  const previous = state.workspaceRuntime;
  state.workspaceRuntime = next;
  previous.terminal.dispose();
  await previous.workspace[Symbol.asyncDispose]();
}
```

- [ ] **Step 6: Run the migrated integration suites**

Run:

```bash
node --test test/pi-workspace.test.ts test/active-workspace.test.ts test/terminal.test.ts test/session.test.ts test/mode.test.ts
npm run typecheck
git diff --check
```

Expected: all pass. These ownership audits must print no matches:

```bash
rg "state\.(binding|piCwd)|setBinding|handoffWorkspace|nearestLiveWorkspace|createModeBashOperations|applyWorkspaceToolPolicy" extensions/termia/index.ts
rg "WorkspaceBinding|target\.scheme|mountRoot|\.hops" extensions/termia/index.ts
rg "SshChain|WorkspaceBinding|readyWorkspace|nearestLiveWorkspace|isWorkspaceHealthy|assertWorkspace" extensions/termia/terminal.ts
```

- [ ] **Step 7: Commit the runtime migration**

```bash
git add extensions/termia/index.ts extensions/termia/terminal.ts extensions/termia/pty-bash.ts test/active-workspace.test.ts test/pi-workspace.test.ts test/terminal.test.ts test/pty-bash.test.ts
git commit -m "refactor: route runtime through active workspace"
```

---

## Task 6: Add atomic Terminal Reset

**Files:**

- Create: `extensions/termia/terminal-reset.ts`
- Create: `test/terminal-reset.test.ts`
- Modify: `extensions/termia/terminal.ts`
- Modify: `test/terminal.test.ts`
- Modify: `extensions/termia/index.ts`
- Modify: `test/pi-workspace.test.ts`

### Interface to establish

Keep the reset module concrete enough to enforce ordering but inject runtime construction and handoff so it is deterministic in tests:

```ts
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ActiveWorkspace } from "./active-workspace.ts";
import type { TerminalController } from "./terminal.ts";

export type ResettableWorkspaceRuntime = {
  workspace: ActiveWorkspace;
  terminal: Pick<TerminalController, "stage" | "commitStaged" | "dispose">;
};

export type TerminalResetResult =
  | { kind: "cancelled" }
  | { kind: "committed"; context: ExtensionCommandContext };

export async function runTerminalReset<T extends ResettableWorkspaceRuntime>(options: {
  ctx: ExtensionCommandContext;
  localCwd: string;
  current: T;
  root: string;
  createStaging(cwd: string): Promise<T> | T;
  replace(staged: T): void;
  handoff?: typeof import("./session.ts").handoffSession;
}): Promise<TerminalResetResult>;
```

### Steps

- [ ] **Step 1: Write failing transaction tests**

Use fake runtimes with ordered call logs and real temporary directories:

`fakeRuntime(name, order)` must return a fake `ActiveWorkspace` whose current execution directory is the temporary cwd and whose async disposer records `dispose-workspace:<name>`, plus a fake terminal whose `stage()`, `commitStaged()`, and `dispose()` record `stage:<cwd>`, `commit:<name>`, and `stop:<name>` respectively.

```ts
test("stages, hands off, swaps, then disposes the old runtime", async (t) => {
  const cwd = temporaryDirectory(t);
  const order: string[] = [];
  const oldRuntime = fakeRuntime("old", order);
  const staged = fakeRuntime("staged", order);

  const result = await runTerminalReset({
    ctx: confirmingContext(),
    localCwd: cwd,
    current: oldRuntime,
    root: "/tmp/termia",
    createStaging: () => { order.push("create"); return staged; },
    replace: (runtime) => { assert.equal(runtime, staged); order.push("swap"); },
    handoff: async (_ctx, target, _root, options) => {
      order.push(`handoff:${target}`);
      await options?.withSession?.(confirmingContext());
      return { cancelled: false, switched: true };
    },
  });

  assert.equal(result.kind, "committed");
  assert.deepEqual(order, [
    "create",
    `stage:${cwd}`,
    `handoff:${cwd}`,
    "swap",
    "stop:old",
    "commit:staged",
    "dispose-workspace:old",
  ]);
});
```

Add complete tests for:

- confirmation declined: no staging, handoff, swap, or disposal;
- invalid/non-directory local cwd: throws before confirmation and mutation;
- staging failure: old runtime untouched;
- handoff cancellation: staged runtime disposed, old runtime untouched;
- handoff throw: staged runtime disposed, old runtime untouched, original error rethrown;
- replacement callback throw: staged runtime disposed, old runtime untouched;
- disposal of old runtime happens only after swap and does not roll the swap back;
- old-runtime cleanup failure still commits the staged terminal history and reports an error;
- a successful staged terminal reaches shell-ready without taking ownership of the live `HistoryStore`.

- [ ] **Step 2: Run the reset suite and verify the missing module failure**

Run:

```bash
node --test test/terminal-reset.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `extensions/termia/terminal-reset.ts`.

- [ ] **Step 3: Add a staged-start lifecycle to TerminalController**

Add these methods without changing normal `start()` behavior:

```ts
async stage(cwd: string, shell = process.env.SHELL ?? "/bin/bash"): Promise<void>;
commitStaged(): void;
```

Refactor normal and staged startup through one private launcher. Staged startup must:

1. Validate cwd/shell and spawn the PTY with a new terminal id exactly as normal startup does.
2. Call `workspaces.resetRoot(cwd, terminalId)` immediately so the staged core has a valid local workspace.
3. Keep `HistoryStore` untouched while the old runtime remains live. Buffer raw PTY data and inspect a separate `ProtocolParser` only to detect the first `ready` token.
4. Resolve `stage()` only after that `ready` token. Reject if spawn fails or the child exits first.
5. Make `dispose()` safe before commit: kill the staged child, clear buffers, reject an unresolved stage, and never call `history.endTerminal()`.
6. Make `commitStaged()` single-use. It calls `history.startTerminal(...)`, switches future PTY data to the normal parser, and replays all buffered raw data exactly once so prompts/output and terminal facts are not lost.
7. Reject `enter()`, `execute()`, and `write()` while staged but not committed with `Termia staged terminal is not committed`.

Add real-shell tests to `test/terminal.test.ts`:

```ts
test("stages a shell without competing for the active HistoryStore", async (t) => {
  const harness = createTerminalHarness(t);
  const staged = createSecondTerminalHarness(t, harness.history);
  harness.terminal.start(harness.cwd, "/bin/bash");

  await staged.terminal.stage(harness.cwd, "/bin/bash");
  assert.equal(staged.terminal.running, true);
  assert.throws(() => staged.terminal.commitStaged(), /already active/);

  harness.terminal.dispose();
  staged.terminal.commitStaged();
  const record = await staged.terminal.execute("printf reset-ready");
  assert.equal(record.exitCode, 0);
});
```

The first `commitStaged()` intentionally proves `HistoryStore` still belongs to the old terminal; for the production transaction, commit only after disposing old. Ensure a failed premature commit does not consume the staged ticket, so the second call can succeed.

- [ ] **Step 4: Implement the staged reset transaction**

Implement this exact state transition:

1. Resolve `localCwd`, `statSync()` it, and reject non-directories before UI or mutation.
2. Ask:

```ts
await ctx.ui.confirm(
  "Reset Termia terminal?",
  "This starts a fresh local terminal and discards the current terminal/SSH chain. Running jobs and unsaved shell state will be lost.",
)
```

3. Build the staged runtime and `await staged.terminal.stage(validatedCwd)`. Because staging buffers protocol data, the live `HistoryStore` and old PTY remain untouched.
4. Read `staged.workspace.current().executionDirectory()` and hand off the Pi session there.
5. Let the `withSession` callback capture the replacement context only. Call `replace(staged)` only after `handoffSession()` returns a successful non-cancelled result.
6. If confirmation or handoff is cancelled, dispose staged and return `{ kind: "cancelled" }`.
7. If anything fails before swap, dispose staged and rethrow; never touch current.
8. After swap, call `current.terminal.dispose()` so it releases the single live `HistoryStore`, then call `staged.terminal.commitStaged()` immediately. Only after the staged history is live should the module await `current.workspace[Symbol.asyncDispose]()`, because SSH cleanup may be slow.
9. Cancellation/failure cleanup calls `staged.terminal.dispose()` and `staged.workspace[Symbol.asyncDispose]()` internally; callers cannot accidentally forget one half. Report old-workspace cleanup failure through `(replacementCtx ?? ctx).ui.notify()` but keep the new runtime committed. A `commitStaged()` failure occurs after the swap boundary and must be reported as a reset failure; do not attempt to resurrect the already-disposed old PTY.
10. Return `{ kind: "committed", context: replacementCtx ?? ctx }` only after the swap and staged-history commit, so title updates target the live Pi context.

Do not make the reset module register Pi hooks or know about `HistoryStore`, `SshChain`, mounts, identities, or raw bindings.

- [ ] **Step 5: Dispatch `/termia reset` before bang parsing**

In the `/termia` command handler, after enabled/nested-PTY guards and before `parseTermiaInvocation(args)`, handle exactly `args.trim() === "reset"`:

```ts
const localCwd = state.workspaceRuntime.terminalFeed.localCwd();
const reset = await runTerminalReset({
  ctx,
  localCwd,
  current: state.workspaceRuntime,
  root: ROOT,
  createStaging: (cwd) => createWorkspaceRuntime(cwd, state.history, state.localBash),
  replace: (staged) => { state.workspaceRuntime = staged; },
});
if (reset.kind === "committed") state.piWorkspace?.show(reset.context);
return;
```

Use `state.localBash` so reset constructs the same detached Bash backend. Catch errors at the command boundary and notify `Termia terminal reset failed: <message>`.

The old persistent terminal must remain reachable until `replace()` executes. Never call `terminal.dispose()` before successful handoff.

- [ ] **Step 6: Run reset, adapter, and lifecycle verification**

Run:

```bash
node --test test/terminal-reset.test.ts test/pi-workspace.test.ts test/active-workspace.test.ts test/terminal.test.ts test/session.test.ts
npm run typecheck
git diff --check
```

Expected: all pass. The cancellation and thrown-handoff tests must assert the old runtime was neither disposed nor replaced, and the real-shell staged-start test must prove two controllers never own one live history session simultaneously.

- [ ] **Step 7: Commit Terminal Reset**

```bash
git add extensions/termia/terminal-reset.ts test/terminal-reset.test.ts extensions/termia/terminal.ts test/terminal.test.ts extensions/termia/index.ts test/pi-workspace.test.ts
git commit -m "feat: add atomic terminal reset"
```

---

## Task 7: Remove legacy seams, document behavior, and verify the complete package

**Files:**

- Delete: `test/workspace-tools.test.ts`
- Delete: `test/workspace.test.ts`
- Modify: `extensions/termia/workspace.ts`
- Modify: `README.md`
- Modify if needed for migrated assertions: `test/active-workspace.test.ts`
- Modify if needed for migrated assertions: `test/pi-workspace.test.ts`

### Steps

- [ ] **Step 1: Prove every legacy assertion has a replacement before deletion**

Create a checklist in the implementation notes and map every old test name to its new test name. At minimum prove replacement coverage for:

| Legacy concern | New owner |
|---|---|
| leaf URI and full hop identity | `active-workspace.test.ts` activation summary |
| IPv6 URI | `active-workspace.test.ts` routed access |
| local absolute / remote relative / explicit SSH paths | `active-workspace.test.ts` `filePath()` |
| malformed URI/password/query/NUL | `active-workspace.test.ts` `filePath()` |
| prompt cwd and skill path presentation | `active-workspace.test.ts` `present()` |
| unavailable tool fail-closed behavior | `active-workspace.test.ts` plus `pi-workspace.test.ts` |
| tilde behavior | `active-workspace.test.ts` plus Pi blocking test |
| remote detached Bash encoding/delegation | `active-workspace.test.ts` `runDetached()` |
| local no-PTY/abort/timeout/concurrency | `active-workspace.test.ts` `runDetached()` |

If any row lacks an assertion, write that failing assertion and make it pass before deleting files.

- [ ] **Step 2: Delete the replaced modules and tests**

Use `apply_patch` to delete the two remaining legacy test files. Remove all remaining exports tied to `applyWorkspaceToolPolicy()`; `createModeBashOperations()` and its tests were already deleted at the Task 5 authority cutover.

Reduce `workspace.ts` exports to only the internal primitives still imported by `active-workspace.ts` and `ssh-workspace.ts`. Do not move SSH command-building or mount lifecycle code merely for cosmetic file size.

- [ ] **Step 3: Document the user-visible model and recovery boundary**

Update `README.md` with a compact section containing these exact facts:

- Agent tools follow the committed Active Workspace, not every transient terminal hop.
- A route/mount/session-handoff failure leaves the terminal in a Pending Workspace while Agent stays in the previous Active Workspace.
- A disconnected remote Active Workspace retains its `ssh://` identity; remote Agent files and Bash are blocked while local absolute file reads remain possible.
- Closing the failed hop in the terminal is the normal recovery path.
- `/termia reset` asks for confirmation, stages a fresh local terminal/session, swaps only after handoff, then discards the old terminal/SSH chain.
- Reset loses terminal jobs and shell state and is never automatic.

Do not describe Reset as guaranteed recovery from process crashes; it guarantees rollback only before the runtime swap completes.

- [ ] **Step 4: Run focused replacement suites**

Run:

```bash
node --test test/active-workspace.test.ts test/pi-workspace.test.ts test/terminal-reset.test.ts test/terminal.test.ts test/ssh-workspace.test.ts test/session.test.ts
npm run typecheck
git diff --check
```

Expected: all pass and no deleted-test imports remain.

- [ ] **Step 5: Run architecture ownership audits**

Run:

```bash
rg "createModeBashOperations|applyWorkspaceToolPolicy|nearestLiveWorkspace|nearestLiveBinding\(" extensions test
rg "state\.(binding|piCwd)|setBinding|handoffWorkspace" extensions/termia/index.ts
rg "WorkspaceBinding|SshChain|MountOperations|IdentityOperations|target\.scheme|mountRoot|\.hops" extensions/termia/index.ts extensions/termia/pi-workspace.ts extensions/termia/terminal-reset.ts
rg "@earendil-works/pi-coding-agent" extensions/termia/active-workspace.ts
rg "new TerminalController\(" extensions test
```

Expected:

- the first four commands print no matches;
- every `new TerminalController(...)` match passes a `TerminalWorkspaceFeed` as its second argument.

If `nearestLiveBinding()` remains as an internal `SshChain` helper needed by its own adapter tests, rename or privatize it so it cannot be used as runtime recovery policy; the caller-facing audit must remain empty.

- [ ] **Step 6: Run the complete verification bundle**

Use `superpowers:verification-before-completion`, then run fresh commands:

```bash
npm test
npm run typecheck
npm pack --dry-run --json
for file in extensions/termia/shell/*.sh extensions/termia/shell/ssh extensions/termia/shell/sudo; do bash -n "$file"; done
git diff --check
git status --short
```

Expected:

- all Node and shell tests pass with only the repository's intentional skips;
- TypeScript exits 0;
- the package dry run returns valid JSON and includes the new runtime files but no test files;
- every shell script passes syntax validation;
- `git diff --check` is empty;
- `git status --short` lists only the intended Task 7 changes before commit.

- [ ] **Step 7: Commit cleanup and documentation**

```bash
git add README.md extensions/termia/workspace.ts test/active-workspace.test.ts test/pi-workspace.test.ts test/workspace-tools.test.ts test/workspace.test.ts
git commit -m "docs: finalize active workspace routing"
```

- [ ] **Step 8: Perform final branch review**

Run:

```bash
git status --short
git log --oneline --decorate -8
git diff --stat main...HEAD
git diff --check main...HEAD
```

Expected: clean status; seven narrow implementation commits after the plan commit; diff limited to the files listed in this plan. Then use `superpowers:requesting-code-review` before offering merge/push/PR actions.
