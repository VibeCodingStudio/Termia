# PTY History Replay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the persistent PTY's recent visible input and output whenever the user switches back from the Agent, without replaying commands or duplicating history.

**Architecture:** `HistoryStore` will expose a bounded, read-only UTF-8 tail of the active transcript while retaining ownership of transcript paths and byte handling. `TerminalController.enter()` will clear only the viewport, reset text attributes, write that tail directly to stdout, and then attach the live PTY without sending `Ctrl+L`; replay failures will be reported without blocking attachment.

**Tech Stack:** TypeScript 5.9, Node.js 22 built-in filesystem and test APIs, `node-pty`, Pi TUI integration

## Global Constraints

- Replay is display-only: never send replayed bytes to the PTY and never append them to history.
- Read at most 1 MiB (`1024 * 1024` bytes) for each PTY attachment; keep the transcript on disk complete.
- Preserve live PTY input, output, resize, `Ctrl+]` detach, process, and Pi TUI redraw behavior.
- Do not change Pi TUI internals, transcript persistence, command extraction, `/history`, dependencies, or package metadata.
- A transcript replay read failure must print one concise warning and continue attaching the live PTY.
- Use test-driven development: observe each new focused test fail before writing its production implementation.

## File Structure

- Modify `extensions/termia/history.ts`: own bounded active-transcript reads and UTF-8 boundary handling.
- Modify `test/history.test.ts`: specify whole, line-aligned, long-line, validation, and non-mutating tail reads.
- Modify `extensions/termia/terminal.ts`: own the 1 MiB display policy and PTY attachment replay flow.
- Modify `test/terminal.test.ts`: specify stdout replay, no `Ctrl+L`, no transcript mutation, preserved detach, and fail-open replay errors.

No new runtime module or dependency is needed. The transcript filesystem seam stays inside `HistoryStore`, and terminal attachment policy stays inside `TerminalController`.

---

### Task 1: Add a bounded active-transcript tail API

**Files:**
- Modify: `test/history.test.ts`
- Modify: `extensions/termia/history.ts:1-3,145-153`

**Interfaces:**
- Consumes: the active terminal's `transcriptPath` and byte `offset`, both already owned by `HistoryStore`.
- Produces: `HistoryStore.readActiveOutputTail(maxBytes: number): string`, a read-only bounded UTF-8 view used by Task 2.

- [ ] **Step 1: Write the failing HistoryStore contract test**

Add this focused test after `records command metadata against transcript byte offsets` in `test/history.test.ts`:

```ts
test("reads bounded active transcript tails without changing history", (t) => {
  const root = mkdtempSync(join(tmpdir(), "termia-history-tail-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const store = new HistoryStore(root);
  store.startTerminal({ id: "tail", shell: "/bin/bash", cwd: "/tmp" });
  store.appendOutput("discard-me\nkeep-me\nlast");
  const completeOffset = store.outputOffset;

  assert.equal(store.readActiveOutputTail(1_024), "discard-me\nkeep-me\nlast");
  assert.equal(
    store.readActiveOutputTail(Buffer.byteLength("p-me\nlast")),
    "last",
  );
  assert.equal(store.outputOffset, completeOffset);
  assert.throws(() => store.readActiveOutputTail(0), /positive safe integer/);

  store.appendOutput("你你你");
  const unicodeOffset = store.outputOffset;
  assert.equal(store.readActiveOutputTail(5), "你");
  assert.equal(store.outputOffset, unicodeOffset);
  store.close();
});
```

The bounded assertion deliberately starts inside `keep-me`, so the expected result proves the partial first line is discarded. The final assertion starts inside a multibyte character on a transcript suffix with no newline, so it proves the long-line fallback does not emit a replacement character.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test --test-name-pattern="reads bounded active transcript tails" test/history.test.ts
```

Expected: FAIL with `TypeError: store.readActiveOutputTail is not a function`.

- [ ] **Step 3: Implement the minimal bounded reader**

Extend the filesystem import in `extensions/termia/history.ts`:

```ts
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from "node:fs";
```

Add this method immediately after `outputOffset`:

```ts
readActiveOutputTail(maxBytes: number): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("Transcript tail limit must be a positive safe integer");
  }

  const terminal = this.requireTerminal();
  const length = Math.min(maxBytes, terminal.offset);
  if (length === 0) return "";

  const start = terminal.offset - length;
  const data = Buffer.allocUnsafe(length);
  const descriptor = openSync(terminal.transcriptPath, "r");
  try {
    let bytesRead = 0;
    while (bytesRead < length) {
      const count = readSync(
        descriptor,
        data,
        bytesRead,
        length - bytesRead,
        start + bytesRead,
      );
      if (count === 0) break;
      bytesRead += count;
    }

    const tail = data.subarray(0, bytesRead);
    if (start === 0) return tail.toString("utf8");

    const newline = tail.indexOf(0x0a);
    if (newline >= 0) return tail.subarray(newline + 1).toString("utf8");

    let alignedStart = 0;
    while (
      alignedStart < tail.length
      && (tail[alignedStart]! & 0xc0) === 0x80
    ) alignedStart += 1;
    return tail.subarray(alignedStart).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}
```

This reads from the file tail rather than loading an unbounded transcript. When truncation occurs, the first newline is the preferred display boundary; if there is no newline, leading UTF-8 continuation bytes are skipped so a single very long line still has a useful bounded suffix.

- [ ] **Step 4: Run the focused and complete HistoryStore tests**

Run:

```bash
node --test --test-name-pattern="reads bounded active transcript tails" test/history.test.ts
node --test test/history.test.ts
```

Expected: both commands PASS with no failures; environment-dependent skips elsewhere are irrelevant to this file.

- [ ] **Step 5: Commit the HistoryStore deliverable**

```bash
git add extensions/termia/history.ts test/history.test.ts
git commit -m "feat: read active PTY transcript tail"
```

---

### Task 2: Replay transcript history during PTY attachment

**Files:**
- Modify: `test/terminal.test.ts:1-20,437-530`
- Modify: `extensions/termia/terminal.ts:42-44,270-341`

**Interfaces:**
- Consumes: `HistoryStore.readActiveOutputTail(maxBytes: number): string` from Task 1.
- Produces: attachment behavior that writes `\u001b[2J\u001b[H\u001b[0m` plus at most 1 MiB of transcript history to stdout before connecting live PTY input.

- [ ] **Step 1: Add a reusable fake TTY/stdout capture helper**

Change the `node:test` import in `test/terminal.test.ts` to:

```ts
import test, { type TestContext } from "node:test";
```

Add this helper after `createTestTerminal`:

```ts
function installFakeTerminalStdio(t: TestContext): string[] {
  const stdinDescriptors = {
    isTTY: Object.getOwnPropertyDescriptor(process.stdin, "isTTY"),
    isRaw: Object.getOwnPropertyDescriptor(process.stdin, "isRaw"),
    setRawMode: Object.getOwnPropertyDescriptor(process.stdin, "setRawMode"),
  };
  const stdoutDescriptors = {
    isTTY: Object.getOwnPropertyDescriptor(process.stdout, "isTTY"),
    write: Object.getOwnPropertyDescriptor(process.stdout, "write"),
  };
  const restore = (target: object, key: string, descriptor: PropertyDescriptor | undefined) => {
    if (descriptor === undefined) Reflect.deleteProperty(target, key);
    else Object.defineProperty(target, key, descriptor);
  };
  const stdoutWrites: string[] = [];

  Object.defineProperties(process.stdin, {
    isTTY: { configurable: true, value: true },
    isRaw: { configurable: true, writable: true, value: false },
    setRawMode: {
      configurable: true,
      value: (raw: boolean) => Reflect.set(process.stdin, "isRaw", raw),
    },
  });
  Object.defineProperties(process.stdout, {
    isTTY: { configurable: true, value: true },
    write: {
      configurable: true,
      value: (chunk: string | Uint8Array) => {
        stdoutWrites.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
        return true;
      },
    },
  });

  t.after(() => {
    process.stdin.pause();
    restore(process.stdin, "isTTY", stdinDescriptors.isTTY);
    restore(process.stdin, "isRaw", stdinDescriptors.isRaw);
    restore(process.stdin, "setRawMode", stdinDescriptors.setRawMode);
    restore(process.stdout, "isTTY", stdoutDescriptors.isTTY);
    restore(process.stdout, "write", stdoutDescriptors.write);
  });
  return stdoutWrites;
}
```

In `allows only one terminal attachment`, replace its inline descriptor setup and restore calls with:

```ts
store.startTerminal({ id: "attach", shell: "/bin/bash", cwd: "/tmp" });
store.appendOutput("[termia] /tmp $ echo kept\r\nkept\r\n[termia] /tmp $ ");
const offsetBeforeReplay = store.outputOffset;
const stdoutWrites = installFakeTerminalStdio(t);
```

Keep the existing controller, fake PTY, delayed `drainInput`, duplicate-attachment, input-forwarding, `Ctrl+]`, listener, and TUI start/stop assertions. Before the existing `finally` block, add:

```ts
assert.equal(stdoutWrites.includes("\u001b[2J\u001b[H\u001b[0m"), true);
assert.equal(
  stdoutWrites.includes("[termia] /tmp $ echo kept\r\nkept\r\n[termia] /tmp $ "),
  true,
);
assert.equal(store.outputOffset, offsetBeforeReplay);
assert.equal(writes.includes("\u000c"), false);
```

- [ ] **Step 2: Add the replay-failure attachment test**

Add this test after `allows only one terminal attachment`:

```ts
test("keeps PTY attachment usable when history replay fails", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "termia-terminal-replay-error-"));
  const store = new HistoryStore(join(root, "state"));
  store.startTerminal({ id: "replay-error", shell: "/bin/bash", cwd: "/tmp" });
  store.readActiveOutputTail = () => {
    throw new Error("transcript unavailable");
  };
  const controller = createTestTerminal(store);
  installFakePty(controller);
  const stdoutWrites = installFakeTerminalStdio(t);
  t.after(() => {
    controller.dispose();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  const tui = {
    start: () => {},
    stop: () => {},
    requestRender: () => {},
    terminal: { drainInput: async () => {} },
  };
  const ctx = {
    ui: {
      custom: (factory: (...args: unknown[]) => unknown) => new Promise((resolve) => {
        factory(tui, undefined, undefined, resolve);
      }),
    },
  } as unknown as Parameters<TerminalController["enter"]>[0];

  const attachment = controller.enter(ctx);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.match(
    stdoutWrites.join(""),
    /\[termia\] Unable to replay PTY history: transcript unavailable/,
  );

  process.stdin.emit("data", Buffer.from([0x1d]));
  assert.deepEqual(await attachment, { type: "detach", shellId: "local" });
});
```

- [ ] **Step 3: Run the focused terminal tests and verify RED**

Run:

```bash
node --test --test-name-pattern="terminal attachment|history replay fails" test/terminal.test.ts
```

Expected: FAIL because attachment does not display the transcript, still sends `Ctrl+L`, and does not catch a replay-read failure.

- [ ] **Step 4: Implement display-only attachment replay**

Add the replay limit next to the other constants in `extensions/termia/terminal.ts`:

```ts
const PTY_HISTORY_REPLAY_BYTES = 1024 * 1024;
```

Add this private method immediately before `enter()`:

```ts
private replayHistory(): void {
  process.stdout.write("\u001b[2J\u001b[H\u001b[0m");
  try {
    const replay = this.history.readActiveOutputTail(PTY_HISTORY_REPLAY_BYTES);
    if (replay.length > 0) process.stdout.write(replay);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`\r\n[termia] Unable to replay PTY history: ${message}\r\n`);
  }
}
```

In the attachment setup inside `enter()`, replace:

```ts
tui.stop();
process.stdout.write("\u001b[2J\u001b[H");
```

with:

```ts
tui.stop();
this.replayHistory();
```

Then delete this line after `onResize()`:

```ts
this.pty?.write("\u000c");
```

Do not route replay through `consumeToken`, `appendOutput`, or `this.write`: direct stdout is the boundary that makes replay display-only.

- [ ] **Step 5: Run focused and file-level terminal tests**

Run:

```bash
node --test --test-name-pattern="terminal attachment|history replay fails" test/terminal.test.ts
node --test test/terminal.test.ts
```

Expected: both commands PASS. The existing test must still prove duplicate attachment rejection, raw input forwarding, `Ctrl+]` detach, listener cleanup, and one Pi TUI restart.

- [ ] **Step 6: Commit the attachment deliverable**

```bash
git add extensions/termia/terminal.ts test/terminal.test.ts
git commit -m "fix: replay PTY history on attach"
```

---

### Task 3: Verify the integrated regression surface

**Files:**
- Verify only: `extensions/termia/history.ts`
- Verify only: `extensions/termia/terminal.ts`
- Verify only: `test/history.test.ts`
- Verify only: `test/terminal.test.ts`

**Interfaces:**
- Consumes: both committed deliverables from Tasks 1 and 2.
- Produces: evidence that the fix preserves the complete Termia runtime and TypeScript contracts.

- [ ] **Step 1: Run the full test suite**

```bash
npm test
```

Expected: all runnable tests PASS, with only the repository's existing environment-dependent skips and zero failures.

- [ ] **Step 2: Run TypeScript validation**

```bash
npm run typecheck
```

Expected: exit code 0 and no TypeScript diagnostics.

- [ ] **Step 3: Check patch hygiene and exact scope**

```bash
git diff --check HEAD~2..HEAD
git diff --stat HEAD~2..HEAD
git status --short --branch
```

Expected: no whitespace errors; the two implementation commits touch only the four planned implementation/test files; the worktree is clean. Do not create an empty verification commit.

- [ ] **Step 4: Perform the manual PTY acceptance check**

Start Pi with the local Termia package loaded, enable Termia, run a command that emits recognizable output, press `Ctrl+]` to return to the Agent, and press `Ctrl+]` again to enter the PTY.

Expected: the previous prompt, command, and output are visible again; typing continues in the same persistent shell; another `Ctrl+]` returns to the Agent. This check is observational only and must not rewrite package or session state.
