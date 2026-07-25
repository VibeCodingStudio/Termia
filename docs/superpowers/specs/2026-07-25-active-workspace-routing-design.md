# Active Workspace Routing Design

## Status

Approved through architecture grilling on 2026-07-25.

## Goal

Deepen Active Workspace routing so every Agent-facing workspace decision comes
from one module and crosses one interface. Remove the duplicated workspace
facts and scheme-specific branching currently spread across the Pi extension,
terminal, path routing, detached Bash, and SSH workspace code.

The design improves locality, leverage, testability, and AI navigability while
preserving Termia's existing terminal, SSH, identity, history, and Pi session
semantics.

## Domain Language

The canonical definitions live in `CONTEXT.md`:

- **Active Workspace** is the single environment in which Agent actions take
  effect while Termia mode is enabled.
- **Pending Workspace** is a terminal environment that has been entered but has
  not yet become the Active Workspace.
- **Terminal Reset** is an explicit, destructive recovery action that replaces
  the persistent terminal and its managed workspace chain with a fresh local
  workspace.

## Scope

This design changes the ownership and test surface of workspace behavior. It
also adds the minimum user-visible behavior needed to make failure states
honest:

- represent Pending Workspace explicitly;
- keep an unavailable Active Workspace identified instead of silently falling
  back;
- provide explicit `/termia reset` recovery.

All other user-visible behavior is frozen:

- `/termia` and `Ctrl+]` behavior;
- the existing Pi session fork and cwd handoff model;
- persistent shell state and history behavior;
- local absolute, remote relative, and explicit `ssh://` path rules;
- detached, concurrent, non-interactive Agent Bash;
- nested SSH and managed identity behavior;
- fail-open interactive terminals and fail-closed Agent privileges;
- no automatic SSH or identity reconnection.

This design does not perform a general `TerminalController` state-machine
refactor, redesign managed identity transport, or replace Pi's session model.

## Current Friction

Active workspace knowledge is currently duplicated:

- `index.ts` stores both `binding` and `piCwd`;
- `TerminalController` exposes another binding through `SshChain`;
- `index.ts` and `workspace.ts` each enumerate workspace-aware tools;
- `pty-bash.ts` reads `target.scheme`, SSH hops, and remote paths directly;
- health is passed separately from the workspace value;
- tests construct raw `WorkspaceBinding` values or reach through private state.

The current modules concentrate useful implementation, but their caller-facing
seam leaks representation. A caller must understand logical paths, physical
mounts, route topology, health, and Pi cwd synchronization to use the workspace
correctly.

## Architecture

```text
TerminalController -- terminal facts --+
                                      | internal seam
                                      v
Pi hooks -- PiWorkspaceAdapter --> ActiveWorkspace
                                      |
                     +----------------+----------------+
                     v                v                v
                  SshChain      WorkspaceMount   IdentityTransport
```

### ActiveWorkspace module

`ActiveWorkspace` is the only module that owns:

- the Active Workspace;
- at most one Pending Workspace;
- workspace generation and activation tickets;
- logical-to-physical path projection;
- detached Bash route selection;
- presentation of logical cwd and skill paths;
- availability and fail-closed policy;
- route and mount readiness during activation.

The module absorbs the workspace policy currently split between
`workspace.ts`, `pty-bash.ts`, `index.ts`, and `TerminalController`. Deleting it
would redistribute that complexity across those callers, so it passes the
deletion test.

### PiWorkspaceAdapter

`PiWorkspaceAdapter` is the only module that knows Pi event shapes and tool
registration details. It owns:

- the workspace-aware tool list;
- `tool_call` integration;
- `before_agent_start` presentation;
- detached Bash registration;
- Pi session handoff orchestration;
- title and notification updates.

Pi session handoff remains outside the ActiveWorkspace implementation. The
adapter supplies the handoff outcome to an activation ticket and never exposes
Pi types through the ActiveWorkspace interface.

### TerminalController

`TerminalController` continues to own PTY process management, attachment,
resize, input, output, and protocol parsing. It forwards already-validated
terminal facts through an internal seam owned by ActiveWorkspace.

It no longer owns caller-facing workspace routing or exposes raw workspace
representation to Agent callers.

### Internal implementation and adapters

`SshChain`, `WorkspaceMount`, and `IdentityTransport` remain behind internal
seams:

- pure topology and path decisions remain in-process implementation;
- SSHFS, ControlMaster, filesystem, and process health remain
  local-substitutable dependencies;
- existing production implementations and deterministic test adapters remain;
- no generic scheme registry or capability registry is introduced.

Local and SSH behavior may use separate internal implementations. Identity is
an SSH route form, not a new external workspace scheme.

## External Interface

The selected design combines a small Pi-agnostic core with a caller-shaped Pi
adapter.

```ts
type WorkspaceGeneration = number & {
  readonly __workspaceGeneration: unique symbol;
};

type WorkspaceAvailability =
  | { kind: "available" }
  | { kind: "unavailable"; reason: string };

type WorkspaceSummary = {
  generation: WorkspaceGeneration;
  uri: string;
  availability: WorkspaceAvailability;
};

interface WorkspaceAccess {
  readonly summary: WorkspaceSummary;

  executionDirectory(): string;
  filePath(input: string): string;
  runDetached(input: DetachedCommand): Promise<DetachedCommandResult>;
  present(input: AgentPresentation): AgentPresentation;
}

type WorkspaceActivation =
  | { kind: "unchanged"; active: WorkspaceSummary }
  | { kind: "pending"; pending: PendingWorkspaceSummary }
  | {
      kind: "ready";
      pending: PendingWorkspaceSummary;
      handoffCwd: string;
      commit(): WorkspaceSummary;
      defer(reason: string): PendingWorkspaceSummary;
    };

interface ActiveWorkspace extends AsyncDisposable {
  current(): WorkspaceAccess;
  prepare(shellId: string): Promise<WorkspaceActivation>;
}
```

The concrete detached-command and presentation types preserve the existing Pi
behavior without carrying Pi-specific types.

### Interface invariants

- Exactly one Active Workspace exists while Termia mode is enabled.
- At most one Pending Workspace corresponds to the actual terminal leaf.
- `prepare()` returns `ready` only after route and mount readiness are proven.
- The caller performs Pi session handoff only after receiving `ready`.
- `commit()` is single-use, synchronous, and valid only after successful
  handoff.
- `defer()` retains the previous Active Workspace and the Pending Workspace.
- Every access and activation carries a generation; stale use fails closed.
- Availability changes increment the Active Workspace generation without
  changing its URI or identity.
- Access methods revalidate generation and availability when invoked rather
  than trusting a previously captured summary.
- A real terminal close event, not nearest-live inference, is required to
  discard a Pending Workspace or expose its parent.
- The interface never exposes `WorkspaceBinding`, scheme discriminants, SSH
  hops, control paths, or mount roots.

## State Model

```text
                        route or mount failure
terminal candidate ------------------------------> Pending(blocked)
        |
        | prepare succeeds
        v
Pending(ready) -- handoff cancelled/failed ------> Pending(deferred)
        |
        | handoff succeeds + valid ticket
        v
Active(new generation)

Active -- route/mount health lost ---------------> Active(unavailable)
Active(unavailable) -- real leaf close + commit --> Active(parent)
```

Pending Workspace never becomes an Agent tool target. Active Workspace never
changes identity merely because a route becomes unavailable.

## Transition Flow

### Terminal detach or persistent command completion

1. Terminal facts update internal topology without changing Active Workspace.
2. The Pi adapter calls `prepare(shellId)` after terminal detach or after a
   persistent command that may have changed cwd.
3. If host, identity, and cwd are unchanged, the module returns `unchanged`.
4. Otherwise it creates Pending Workspace and waits for route and mount
   readiness.
5. When ready, the adapter performs the existing Pi session handoff using
   `handoffCwd`.
6. Successful handoff calls `commit()` and updates title and presentation.
7. Cancelled or failed handoff calls `defer()` and reports that Agent remains in
   the previous Active Workspace.

Pressing `Ctrl+]` to re-enter and leave the terminal retries preparation for the
actual terminal leaf.

### Pending Workspace close

When the user exits a Pending Workspace, the shell emits a real close event.
The internal topology then exposes the actual parent candidate. The next
preparation either returns `unchanged` or follows the normal handoff and commit
flow.

### Active Workspace disconnect

An Active Workspace that loses route or mount health stays active but becomes
unavailable:

- remote relative and `ssh://` file operations fail closed;
- detached remote Bash fails closed;
- local absolute file paths remain available;
- no operation is silently sent through a parent identity or host;
- no automatic reconnect or automatic parent fallback occurs.

The availability change creates a new generation so an access obtained before
disconnect cannot continue routing with stale assumptions.

The user may re-enter the terminal and exit the affected leaf. A real close
event then permits a normal transition to the parent. If the PTY cannot be
re-entered or cannot produce a close event, Terminal Reset is the recovery
path.

## Routing and Presentation

### File tools

The Pi adapter owns one list of workspace-aware file tools. It asks the current
`WorkspaceAccess` to resolve every path:

- local absolute paths remain on the machine running Pi;
- relative paths resolve from the Active Workspace cwd;
- matching `ssh://` paths resolve through the Active Workspace projection;
- malformed, unsupported, mismatched, traversal, NUL, and remote `~` paths
  preserve the existing error semantics;
- an unavailable remote route blocks remote paths but not local absolute paths.

Callers never receive a mount root or reconstruct projection rules.

### Detached Bash

The Pi adapter delegates detached Bash to `WorkspaceAccess.runDetached()`.
The ActiveWorkspace implementation chooses local or SSH execution and hides
route command construction. Detached Bash remains concurrent,
non-interactive, and outside Termia history.

### Prompt and title

The system prompt and title always describe Active Workspace. They never
present Pending Workspace as an Agent target.

Available title:

```text
Termia — ssh://user@host/path
```

Unavailable title:

```text
Termia — ssh://user@host/path · unavailable
```

Skill locations already inside a remote projection continue to appear as
logical `ssh://` paths. Local absolute skill paths remain local.

## Error Handling

The module uses typed errors or discriminated results for expected states:

- `WorkspacePathError`: invalid or disallowed path input;
- `WorkspaceUnavailableError`: a remote operation requested from an
  unavailable Active Workspace;
- `WorkspacePreparationError`: route or mount preparation failed while Pending
  Workspace remains available for retry or exit;
- `StaleWorkspaceAccessError`: an operation used an old generation;
- `StaleActivationError`: a ticket was repeated, superseded, or no longer
  matches the terminal leaf;
- `DetachedCommandError`: existing abort, timeout, output, and exit behavior.

Expected transition failures do not mutate Active Workspace. Ordering errors
fail closed. Error messages include the relevant workspace URI and an action
the user can take.

When preparation or handoff fails, the Pi adapter reports:

```text
Pending workspace: ssh://root@host/root
Mount unavailable: <reason>
Agent remains in ssh://user@host/home/user
```

The notification appears once per failed attempt. It does not replace title or
prompt state.

Command history always records the terminal environment in which a command
actually ran. A command executed in Pending Workspace keeps that real URI even
though Agent tools remain in the previous Active Workspace.

## Terminal Reset

`/termia reset` is an explicit recovery path, not a method on the normal
ActiveWorkspace interface.

The Terminal Reset adapter performs this flow:

1. Validate the last verified local cwd and local shell before destructive
   work.
2. Show a confirmation that names the lost persistent shell state, jobs, and
   nested workspaces.
3. Construct a fresh local terminal and ActiveWorkspace runtime in staging.
4. Perform the existing Pi session handoff to the staged local workspace.
5. On success, atomically replace the runtime.
6. Dispose the old PTY, route, mount, and identity resources.
7. Report cleanup failure as a warning without rolling back the new runtime.

Cancellation, staging failure, or handoff failure leaves the old runtime
unchanged. Terminal Reset never runs automatically.

## Testing Strategy

### ActiveWorkspace interface tests

The primary behavior tests exercise only `current()` and `prepare()` plus the
returned access and activation interfaces:

- local, SSH, identity, and cwd transitions;
- unchanged preparation;
- route and mount preparation failures;
- handoff cancellation, deferral, retry, and commit;
- stale access, stale ticket, repeated commit, and competing terminal facts;
- Active Workspace disconnect without identity change;
- remote file and Bash fail-closed behavior;
- local absolute paths during remote disconnect;
- real close-event recovery to a parent;
- prompt, title, and logical skill-path presentation;
- history provenance for Pending Workspace commands.

Assertions observe workspace summaries, routed operations, errors, and command
results through the interface. They do not inspect topology, mount maps, raw
bindings, or private fields.

### PiWorkspaceAdapter tests

Adapter tests prove:

- Pi hooks are installed once;
- one module owns the workspace-aware tool list;
- current access is acquired for every Agent operation;
- session handoff precedes commit;
- cancellation and failure defer the activation;
- title, prompt, and notification behavior uses only Active Workspace;
- no Pi caller reads SSH hops, mount roots, or scheme discriminants.

### Adapter contract tests retained

Keep focused tests for implementation that earns its seam:

- protocol frame parsing;
- SSH command construction and quoting;
- mount readiness, health, takeover, and cleanup;
- identity transport and OpenSSH/Dropbear behavior;
- shell hooks and PTY integration;
- Pi session create, fork, retire, and release behavior.

### Shallow tests replaced

Once equivalent interface coverage exists, remove tests that:

- construct a full `WorkspaceBinding` only to call policy helpers;
- cast a partial fake to `TerminalController`;
- use reflection to invoke private reducers or read private workspace state;
- test pass-through modules whose behavior is now covered through the
  ActiveWorkspace interface.

Adapter contract tests are not deleted merely because their implementation is
internal.

### Verification

The implementation must pass:

```text
npm test
npm run typecheck
npm pack --dry-run --json
bash -n extensions/termia/shell/termia.bash
bash -n extensions/termia/shell/termia.zsh
bash -n extensions/termia/shell/termia.ash
bash -n extensions/termia/shell/termia-ssh.sh
bash -n extensions/termia/shell/termia-identity.sh
git diff --check
```

The credential-isolated SSH integration remains an optional environment-gated
acceptance test.

## Rejected Designs

### Generic action dispatcher

A three-method design using `apply(action)` appears small but moves interface
complexity into a large action union. It makes simple synchronous operations
less direct and hides weakly related behavior behind one verb without adding
depth.

### One method per current hook

An explicit interface with separate inspect, tool, Bash, presentation, reset,
and cleanup methods mirrors current implementation too closely. It provides
less depth and tends to grow whenever Pi adds another caller.

### Pi session inside ActiveWorkspace

Injecting Pi session switching into ActiveWorkspace would hide the commit order
but leak Pi-specific concepts into its interface and replace the existing
handoff model. The Pi adapter instead owns the external handoff and completes a
single-use activation ticket.

### Automatic parent fallback or reconnect

Selecting a nearest-live binding does not prove that the PTY has exited the
failed leaf. Automatic fallback can route Agent operations through the wrong
host or identity, so recovery requires a real close event or explicit Terminal
Reset.

### File-size-driven splitting

`ProtocolParser`, `WorkspaceMount`, `IdentityTransport`, and `SshChain` already
concentrate meaningful complexity. This design keeps their useful depth and
changes the leaking seam around them instead of splitting files for size alone.

## Acceptance Criteria

- `index.ts` no longer stores `binding` or `piCwd`.
- No Agent caller reads workspace scheme, SSH hops, control paths, or mount
  roots.
- One module owns the workspace-aware tool list.
- Every Agent file, Bash, prompt, and title decision uses one Active Workspace
  generation.
- Workspace change becomes active only after route/mount readiness and
  successful Pi session handoff.
- Failed or cancelled handoff retains previous Active Workspace and explicit
  Pending Workspace.
- Unavailable remote workspaces fail closed without silent fallback while local
  absolute paths remain available.
- Parent recovery requires a real close event.
- `/termia reset` is explicit, confirmed, staged, and never automatic.
- Tests treat the ActiveWorkspace interface as the primary test surface while
  retaining valuable adapter contract coverage.
- All frozen user-visible behavior remains unchanged.
