# Session History Command and Idle Shortcut Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose `/history` only inside Termia-managed sessions and discard `Ctrl+]` pressed while the Agent is running.

**Architecture:** Termia pre-stages its enabled flag before Pi replaces the session runtime, then the new session's `session_start` handler conditionally registers `/history` before autocomplete is rebuilt. The editor wrapper receives the active session's public idle predicate and consumes the terminal shortcut without submission while that predicate is false.

**Tech Stack:** TypeScript, Pi extension API, Node test runner

## Global Constraints

- Normal Pi sessions register `/termia` but not `/history`.
- Termia-managed sessions register `/history`; `/termia-history` is removed.
- Busy `Ctrl+]` is silent, unqueued, and never replayed.
- Disabled and idle shortcut behavior remains unchanged.
- No private Pi APIs or input interception.

---

### Task 1: Consume the terminal shortcut while the Agent is busy

**Files:**
- Modify: `test/bang-editor.test.ts`
- Modify: `extensions/termia/bang-editor.ts`
- Modify: `extensions/termia/index.ts`

**Interfaces:**
- Consumes: `ExtensionContext.isIdle(): boolean` from the active `session_start` context.
- Produces: `BangEditor`'s existing `Ctrl+]` behavior gated by a new idle predicate.

- [ ] **Step 1: Add the failing busy-shortcut test**

Add a test that constructs `BangEditor` with `enabled === true` and an idle predicate that starts false. Press `Ctrl+]`, switch the predicate to true without another keypress, and assert that no draft or command was submitted. Then press `Ctrl+]` again and assert exactly one `/termia __terminal` submission.

```ts
test("consumes busy Ctrl+] without replaying it after the Agent becomes idle", () => {
  const base = new FakeEditor();
  let idle = false;
  const drafts: string[] = [];
  const submitted: string[] = [];
  const editor = new BangEditor(
    base,
    () => true,
    (draft) => drafts.push(draft),
    () => idle,
  );
  editor.onSubmit = (text) => submitted.push(text);
  editor.setText("keep this draft");

  editor.handleInput("\x1d");
  idle = true;

  assert.deepEqual(base.inputs, []);
  assert.deepEqual(drafts, []);
  assert.deepEqual(submitted, []);

  editor.handleInput("\x1d");
  assert.deepEqual(drafts, ["keep this draft"]);
  assert.deepEqual(submitted, ["/termia __terminal"]);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test test/bang-editor.test.ts
```

Expected: FAIL because the fourth constructor argument is ignored and the first keypress submits the terminal command.

- [ ] **Step 3: Add the idle predicate and consume busy input**

Add a defaulted fourth constructor/factory/install argument:

```ts
readonly #idle: () => boolean;

constructor(
  base: EditorComponent,
  enabled: () => boolean,
  onTerminalShortcut: (draft: string) => void = () => {},
  idle: () => boolean = () => true,
) {
  // existing assignments
  this.#idle = idle;
}
```

Gate only the enabled shortcut:

```ts
if (this.#enabled() && matchesKey(data, "ctrl+]")) {
  if (!this.#idle()) return;
  this.#onTerminalShortcut(this.#base.getText());
  this.#onSubmit(`/termia ${TERMINAL_INVOCATION}`);
  return;
}
```

Pass `() => ctx.isIdle()` from the active `session_start` handler through `installBangEditor`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
node --test test/bang-editor.test.ts
```

Expected: all bang-editor tests pass.

- [ ] **Step 5: Commit the shortcut fix**

```bash
git add extensions/termia/bang-editor.ts extensions/termia/index.ts test/bang-editor.test.ts docs/superpowers/plans/2026-07-24-session-history-and-idle-shortcut.md
git commit -m "fix: discard busy terminal shortcuts"
```

### Task 2: Register `/history` only in Termia sessions

**Files:**
- Modify: `test/history-overlay.test.ts`
- Modify: `extensions/termia/history-overlay.ts`
- Modify: `extensions/termia/index.ts`

**Interfaces:**
- Consumes: the pre-staged `TermiaRuntime.enabled` value during `session_start`.
- Produces: `registerHistoryCommand(api, enabled, history)` and the `/history` overlay command.

- [ ] **Step 1: Add the failing command-registration test**

Add a focused test that records registered names, calls the new helper while disabled and enabled, and expects only `history`:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HistoryStore } from "../extensions/termia/history.ts";
import { registerHistoryCommand } from "../extensions/termia/history-overlay.ts";

const registered: string[] = [];
const api = {
  registerCommand: (name: string) => registered.push(name),
} as unknown as Pick<ExtensionAPI, "registerCommand">;
const store = {} as HistoryStore;

registerHistoryCommand(api, false, store);
assert.deepEqual(registered, []);
registerHistoryCommand(api, true, store);
assert.deepEqual(registered, ["history"]);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test test/history-overlay.test.ts
```

Expected: FAIL because `registerHistoryCommand` does not exist.

- [ ] **Step 3: Move command registration beside the history overlay**

Export `registerHistoryCommand` from `history-overlay.ts`. Return immediately when disabled; otherwise register `history` with the current overlay handler and description `Show persistent-shell command history`.

In `index.ts`, call it from `session_start` after obtaining the runtime state, and delete the global `termia-history` registration block.

- [ ] **Step 4: Pre-stage the mode flag across session replacement**

Immediately before `startManagedSession` or `releaseManagedSession`, set `state.enabled` to the target mode so the replacement runtime's `session_start` sees the correct value. Preserve the previous value and restore it when the transition is cancelled, does not switch, or throws. Keep `applyMode` inside `withSession` so the replacement runtime still synchronizes tools and terminal state.

- [ ] **Step 5: Run focused mode, session, and history tests**

Run:

```bash
node --test test/history-overlay.test.ts test/mode.test.ts test/session.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 6: Commit the session-scoped command**

```bash
git add extensions/termia/history-overlay.ts extensions/termia/index.ts test/history-overlay.test.ts
git commit -m "feat: scope history command to Termia sessions"
```

### Task 3: Update user-facing names and verify the package

**Files:**
- Modify: `extensions/termia/index.ts`
- Modify: `extensions/termia/bang-result.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: the new `/history` command name.
- Produces: consistent hints, entry notices, and documentation.

- [ ] **Step 1: Replace user-facing command references**

Change current user-facing `/termia-history` references to `/history`. Update the first entry notice to:

```text
Termia enabled · /history opens command history · Ctrl+] switches between Agent and PTY
```

Update later entry notices to:

```text
Termia enabled · /history opens command history
```

Document that busy `Ctrl+]` is discarded rather than deferred.

- [ ] **Step 2: Check current sources for stale names**

Run:

```bash
rg -n 'termia-history' README.md extensions test
```

Expected: no matches. Historical design and plan documents are not rewritten.

- [ ] **Step 3: Run the complete verification bundle**

Run:

```bash
npm test
npm run typecheck
npm pack --dry-run --json
git diff --check
```

Expected: 0 failures, typecheck exit 0, package dry-run exit 0, and no whitespace errors.

- [ ] **Step 4: Commit the documentation and hints**

```bash
git add README.md extensions/termia/index.ts extensions/termia/bang-result.ts
git commit -m "docs: use the session history command"
```
