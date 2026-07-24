# Shell Quick-Ask Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Completely remove the PTY-side `termia ...` quick-ask command while preserving Pi's `/termia` mode, terminal switching, history, Bash, cwd, and SSH behavior.

**Architecture:** Delete the feature at its three boundaries: shell function, shell protocol/controller, and Agent runtime. Simplify the remaining terminal attachment to one detach result and retain only protocol tokens used for readiness, command recording, explicit execution, and SSH workspaces.

**Tech Stack:** TypeScript, Node.js test runner, node-pty, bash, zsh, BusyBox ash/sh, Pi extension API.

## Global Constraints

- Do not retain a compatibility function, alias, redirect, warning, or hidden quick-ask engine.
- Keep Pi's `/termia`, `Ctrl+]`, `!`, `!!`, `/history`, and `termia_history` behavior.
- Keep manual command recording, Agent Bash, cwd handoff, SSH workspaces, and nested SSH behavior.
- Work directly on the user-approved `main` checkout and do not push or publish during implementation.

---

### Task 1: Remove the shell command

**Files:**
- Modify: `test/terminal.test.ts`
- Modify: `extensions/termia/shell/termia.bash`
- Modify: `extensions/termia/shell/termia.zsh`
- Modify: `extensions/termia/shell/termia.ash`

**Interfaces:**
- Consumes: shell hooks installed by `TerminalController.start(cwd, shell)`.
- Produces: hooks that provide protocol/history/SSH behavior but no `termia()` function.

- [ ] **Step 1: Change the shell-controller contract first**

Replace the existing positive function assertion in `test/terminal.test.ts` with:

```ts
const functionCheck = await controller.execute("type termia");
assert.notEqual(functionCheck.exitCode, 0);
assert.doesNotMatch(store.readOutput(functionCheck), /termia is a (?:shell )?function/);
```

In the same test file, delete the quick request/response and abort sections
inside the bash lifecycle test. Delete the BusyBox quick-ask portion and rename
that test to `runs Agent commands in BusyBox ash`. Delete the entire
`ignores Ctrl+] while a quick ask is running` test. Retain manual-command,
explicit-execution, attachment, prompt, cwd, and SSH assertions.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test test/terminal.test.ts
```

Expected: FAIL because the current bash hook still defines `termia` and `type termia` exits 0.

- [ ] **Step 3: Delete the shell functions**

Delete the complete `termia() { ... }` block from `termia.bash`, `termia.zsh`, and `termia.ash`.

In `termia.ash`, change the manual-history exclusion from:

```sh
''|__termia_*|termia|termia\ *|ssh|ssh\ *|*termia.ash*) return ;;
```

to:

```sh
''|__termia_*|ssh|ssh\ *|*termia.ash*) return ;;
```

Do not change readiness, command start/end, explicit execution, prompt, or SSH hook code.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
node --test test/terminal.test.ts
```

Expected: all non-skipped terminal tests pass and no assertion waits for a quick ask.

- [ ] **Step 5: Commit the shell removal**

```bash
git add test/terminal.test.ts extensions/termia/shell/termia.bash extensions/termia/shell/termia.zsh extensions/termia/shell/termia.ash
git commit -m "refactor: remove shell quick-ask command"
```

---

### Task 2: Delete the quick-ask protocol and Agent runtime

**Files:**
- Modify: `test/protocol.test.ts`
- Modify: `test/pty-bash.test.ts`
- Modify: `extensions/termia/protocol.ts`
- Modify: `extensions/termia/terminal.ts`
- Modify: `extensions/termia/pty-bash.ts`
- Modify: `extensions/termia/index.ts`
- Delete: `extensions/termia/quick-ask.ts`
- Delete: `extensions/termia/quick-runtime.ts`
- Delete: `test/quick-ask.test.ts`
- Delete: `test/quick-runtime.test.ts`

**Interfaces:**
- Consumes: remaining `ProtocolToken` readiness, command, execution, and SSH variants.
- Produces: `TerminalAttachExit = { type: "detach"; shellId: string }` and `TerminalController.enter(ctx): Promise<TerminalAttachExit>` with no quick-ask options.

- [ ] **Step 1: Add the protocol deletion assertion first**

Replace the current valid quick-ask round-trip test in `test/protocol.test.ts` with:

```ts
test("keeps removed quick-ask frames as terminal output", () => {
  const parser = new ProtocolParser();
  const frame = frameOf("Q", b64("local"), b64("/tmp"), "1", b64z(["why"]));
  assert.deepEqual(parser.push(frame), [{ type: "output", data: frame }]);
});
```

Keep the existing malformed-frame assertion until the parser branch is removed.

- [ ] **Step 2: Run the protocol test and verify RED**

Run:

```bash
node --test test/protocol.test.ts
```

Expected: FAIL because a valid `Q` frame still parses as `{ type: "quickAsk", ... }`.

- [ ] **Step 3: Remove the protocol variant**

Delete `QuickAskRequest`, `QuickAskEvent`, the `QuickAskEvent` member of
`ProtocolToken`, the `Q` case in `parsePayload`, and any decoder used only by
that case. Update protocol fixtures that previously included a `quickAsk` token.

- [ ] **Step 4: Simplify `TerminalController`**

Delete these quick-ask-only members and APIs:

```ts
QuickAskListener
TerminalEnterOptions
quickAskListeners
activeQuickAsk
quickAskControlExited
onQuickAsk()
completeQuickAsk()
```

Make `TerminalAttachExit` a single object type:

```ts
export type TerminalAttachExit = { type: "detach"; shellId: string };
```

Change `enter` to:

```ts
async enter(ctx: TerminalContext): Promise<TerminalAttachExit>
```

Inside the attachment input handler, always forward non-`Ctrl+]` input to the
PTY. Always resume the TUI when the attachment finishes. Remove quick-ask output
suppression, control-exit recovery, protocol dispatch, and disposal state.

- [ ] **Step 5: Simplify the extension entry point**

Delete quick-ask imports, `TERMIA_EXTENSION_PATH`, `AttachedTurn`,
`attachedTurn`, `quickAskActive`, `message_end` attached capture, and all helper
functions from `finishAttachedTurn` through the quick-ask dispatch loop.

Replace `terminalLoop` with one attachment and the existing cwd handoff:

```ts
async function terminalLoop(
  state: TermiaRuntime,
  active: ActiveTerminalContext,
): Promise<void> {
  const exit = await state.terminal.enter(active.ctx);
  const binding = await state.terminal.readyWorkspace(exit.shellId);
  if (binding.piCwd === active.ctx.cwd) {
    setBinding(state, binding);
    showWorkspace(active.ctx, state);
    return;
  }
  const result = await handoffWorkspace(active.ctx, state, binding);
  if (result.cancelled) active.ctx.ui.notify("Termia cwd change was cancelled", "warning");
}
```

Remove the `!state.quickAskActive` clause from session cwd restoration.

- [ ] **Step 6: Delete the detached runtime and persistent-PTY Bash adapter**

Delete `quick-ask.ts`, `quick-runtime.ts`, and their two dedicated test files.
Delete `createPtyBashOperations` from `pty-bash.ts`; retain
`createModeBashOperations` unchanged. Remove the `createPtyBashOperations`
tests and imports from `test/pty-bash.test.ts`.

- [ ] **Step 7: Run focused tests and typecheck**

Run:

```bash
node --test test/protocol.test.ts test/terminal.test.ts test/pty-bash.test.ts
npm run typecheck
```

Expected: all focused non-skipped tests pass and TypeScript reports no errors.

- [ ] **Step 8: Verify no implementation references remain**

Run:

```bash
! rg -n 'QuickAsk|quickAsk|runQuickPrint|parseQuickAsk|buildQuickMessages|createPtyBashOperations|onQuickAsk|completeQuickAsk' extensions test
```

Expected: exit 0 with no matches.

- [ ] **Step 9: Commit the runtime deletion**

```bash
git add extensions/termia test
git commit -m "refactor: delete quick-ask runtime"
```

---

### Task 3: Update the public contract and verify the package

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-07-24-remove-shell-quick-ask.md`

**Interfaces:**
- Consumes: the remaining `/termia`, `Ctrl+]`, Bash, history, cwd, and SSH behavior.
- Produces: public documentation with no PTY-side quick-ask interface.

- [ ] **Step 1: Rewrite the README quick-ask section**

Replace the shell quick-ask examples and behavior with:

```md
To ask the Agent from the persistent shell, press `Ctrl+]` to return to Pi and
submit a normal message. The shell does not define a separate `termia` command.
```

Remove documentation for detached/attached mode, quick-ask flags, quick-ask
Bash history, quick-ask abort behavior, and quick-ask limitations. Keep the
ordinary Agent Bash explanation and state that it remains outside `/history`.

- [ ] **Step 2: Search for stale public and implementation references**

Run:

```bash
! rg -n 'quick ask|quick-ask|termia --attach|termia -n|termia h~|termia --all|runQuickPrint|QuickAsk' README.md extensions test
```

Expected: exit 0 with no matches.

- [ ] **Step 3: Run the complete automated verification**

Run:

```bash
npm test
npm run typecheck
npm pack --dry-run --json
git diff --check
```

Expected: zero test failures, typecheck exit 0, the package omits the deleted
files, and the diff check is clean.

- [ ] **Step 4: Run the real Pi TUI smoke test**

Start Pi with only the local Termia extension in a temporary session directory.
Run `/termia`, press `Ctrl+]`, then run:

```sh
type termia
```

Expected: nonzero shell status and no shell-function description. Press
`Ctrl+]` and confirm Pi returns to the Agent. Exit Pi and remove only the exact
test sessions and temporary directory created by this smoke test.

- [ ] **Step 5: Commit documentation and verification updates**

```bash
git add README.md docs/superpowers/plans/2026-07-24-remove-shell-quick-ask.md
git commit -m "docs: remove shell quick-ask usage"
```
