# Termia 0.1.1 Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make long BusyBox ash commands timeout correctly and give reconnectable SSH workspaces stable local paths.

**Architecture:** Keep the existing PTY and SSHFS ownership model. Split only explicit-exec input lines, interrupt any written execution on abort, and separate the stable mount root from the random bridge-script root.

**Tech Stack:** TypeScript, Node.js, node-pty, BusyBox-compatible shell, SSHFS, Node test runner.

## Global Constraints

- Publish exactly `@vibecodingstudio/termia@0.1.1`.
- Add no dependencies.
- Keep visible SSH paths under `/tmp/termia-ssh`.
- Never take over another active stable mountpoint.

---

### Task 1: PTY regression tests and fix

**Files:**
- Modify: `test/terminal.test.ts`
- Modify: `extensions/termia/terminal.ts`
- Modify: `extensions/termia/shell/termia.ash`

**Interfaces:**
- Consumes: `TerminalController.execute(command, options)` and ash `__termia_exec`.
- Produces: bounded explicit-exec input and pre-start `Ctrl+C` interruption.

- [ ] **Step 1: Write failing tests**

Add fake-PTY tests that assert a long explicit-exec payload is emitted in lines below the ash input ceiling and that abort writes `\u0003` even when no protocol sequence exists.

- [ ] **Step 2: Verify RED**

Run: `node --test --test-name-pattern='chunks long explicit|interrupts written commands before start' test/terminal.test.ts`

Expected: both tests fail against the single-line/gated-abort implementation.

- [ ] **Step 3: Implement the minimum fix**

Emit `__termia_payload=` plus bounded append lines and a final `__termia_exec "$__termia_payload"`. Change the abort condition from “has sequence” to “was written”, and ignore all `__termia_*` ash history entries.

- [ ] **Step 4: Verify GREEN**

Run the focused command from Step 2 and `node --test test/pty-bash.test.ts test/terminal.test.ts`.

Expected: all focused PTY tests pass.

### Task 2: Stable SSH workspace path

**Files:**
- Modify: `test/ssh-workspace.test.ts`
- Modify: `extensions/termia/ssh-workspace.ts`

**Interfaces:**
- Consumes: `workspaceMountName(hops)`.
- Produces: `workspaceMountPath(hops)` rooted at `/tmp/termia-ssh`.

- [ ] **Step 1: Write the failing path test**

Change the path assertion to call `workspaceMountPath(hops)` and expect `/tmp/termia-ssh/2-bob@10.0.0.20-p2222`.

- [ ] **Step 2: Verify RED**

Run: `node --test test/ssh-workspace.test.ts`

Expected: failure because the current function requires a random runtime root.

- [ ] **Step 3: Implement the minimum fix**

Use a constant `join(tmpdir(), "termia-ssh")` mount root, create each named directory exclusively, and keep `mkdtemp` only for bridge scripts.

- [ ] **Step 4: Verify GREEN**

Run: `node --test test/ssh-workspace.test.ts test/ssh-integration.test.ts`.

Expected: stable-path unit tests pass; integration runs when its prerequisites are available.

### Task 3: Release 0.1.1

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: npm package `@vibecodingstudio/termia@0.1.1` with `latest=0.1.1`.

- [ ] **Step 1: Set the version**

Run: `npm version 0.1.1 --no-git-tag-version`

- [ ] **Step 2: Verify the release candidate**

Run `npm test`, `npm run typecheck`, shell syntax checks, `git diff --check`, `npm audit --omit=dev`, and `npm pack --dry-run --json`.

- [ ] **Step 3: Commit and push**

Commit the tested source, tests, docs, and version files; push `main` and verify `HEAD` matches `origin/main`.

- [ ] **Step 4: Publish and verify**

Run `npm publish --access public`, verify the public registry metadata and tarball checksum, then install `npm:@vibecodingstudio/termia@0.1.1` into an isolated Pi directory and confirm `/termia` and `/termia-history` register.
