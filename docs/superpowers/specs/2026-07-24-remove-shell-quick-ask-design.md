# Remove the Shell Quick-Ask Command

## Goal

Remove the `termia ...` command from the persistent Termia shell. Asking the
Agent from the PTY is no longer a separate feature: users switch back to the
Agent with `Ctrl+]` and submit a normal message there.

Pi's `/termia` command remains the mode toggle. The two commands share a name
but are otherwise separate surfaces.

## Removed Behavior

- The bash, zsh, ash, and BusyBox sh hooks no longer define a `termia` shell
  function.
- Typing `termia` in the PTY follows normal shell resolution and ordinarily
  reports `command not found`.
- Detached print-mode quick asks, `--attach`, history-selection arguments, and
  quick-ask-specific Pi argument handling are removed.
- The shell-to-extension quick-ask protocol and its completion/abort path are
  removed.
- Quick-ask-only Agent runtime construction and persistent-PTY Bash operations
  are removed.

No compatibility function, redirect, deprecation notice, alias, or hidden
quick-ask engine remains.

## Preserved Behavior

- `/termia` enables and disables Termia mode.
- `Ctrl+]` switches between the Agent and the PTY while the Agent is idle.
- `!`, `!!`, `/history`, and `termia_history` retain their current behavior.
- Manual command recording, Agent Bash, cwd handoff, SSH workspaces, nested SSH,
  reconnect behavior, and shell prompts remain unchanged.
- Shell protocol messages for readiness, command recording, explicit Agent
  execution, and SSH workspace changes remain supported.

## Code Boundaries

Delete `quick-ask.ts` and `quick-runtime.ts` and their dedicated tests. Remove
their imports, runtime state, attached-turn event handlers, and dispatch loop
from `index.ts`.

Remove the quick-ask protocol token from `protocol.ts`. Simplify
`TerminalController` so a terminal attachment exits only on `Ctrl+]` or PTY
termination; remove quick-ask listeners, completion replies, output suppression,
and abort routing. Delete `createPtyBashOperations` once it has no production
caller.

Remove the `termia()` function from every shell hook. Keep the remaining hook
code intact so command history and explicit execution continue working across
all supported shells.

Update the README to describe switching back to the Agent instead of invoking
a shell quick ask. Remove quick-ask flags, examples, behavior, and limitations.

## Validation

- Add or change a shell-controller test first so it expects `type termia` to
  fail after hook installation.
- Remove tests whose only subject is the deleted quick-ask feature.
- Keep protocol, terminal, shell, SSH, history, bang, and mode tests passing.
- Run the full test suite, typecheck, package dry run, stale-reference search,
  and `git diff --check`.
- In a real Pi TUI, enable `/termia`, enter the PTY, confirm `type termia` fails,
  then use `Ctrl+]` to return to the Agent.

## Success Criteria

The published package contains no shell quick-ask implementation or documented
quick-ask interface. The persistent terminal and Agent remain connected only by
the existing mode/session, workspace, history, Bash, and `Ctrl+]` behavior.
