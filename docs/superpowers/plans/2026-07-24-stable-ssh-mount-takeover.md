# Stable SSH Mount Takeover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reuse a stable Termia SSH workspace path by safely replacing a stale directory or old SSHFS mount.

**Architecture:** Keep `WorkspaceMount` as the owner of mount lifecycle. Add one small path-preparation helper that attempts platform-native unmount, verifies the path is detached, and only then recursively replaces it; call it at the existing `mkdir` collision point.

**Tech Stack:** TypeScript, Node.js `fs/promises`, SSHFS, `fusermount3`/`umount`, Node test runner.

## Global Constraints

- Preserve `/tmp/termia-ssh/<depth>-<user>@<host>` naming.
- An older Termia process may lose its SSHFS view when the path is taken over.
- Never recursively remove a path that still resolves as a mount point.
- Add no locks, ownership registry, reconnection, or dependency.

---

### Task 1: Safely replace a stable SSH mount path

**Files:**
- Modify: `extensions/termia/ssh-workspace.ts`
- Test: `test/ssh-workspace.test.ts`

**Interfaces:**
- Produces: `prepareWorkspaceMountPath(path: string): Promise<void>` for the existing `WorkspaceMount.mount()` setup path.

- [ ] **Step 1: Write the failing stale-directory regression test**

Create a non-empty workspace directory under a temporary parent, call `prepareWorkspaceMountPath()`, and assert that the same directory exists empty afterward:

```ts
test("replaces a stale stable workspace directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "termia-stale-mount-"));
  const target = join(root, "1-alice@host-a");
  await mkdir(target);
  await writeFile(join(target, ".termia-probe-old"), "stale");
  t.after(() => rm(root, { recursive: true, force: true }));

  await prepareWorkspaceMountPath(target);

  assert.deepEqual(await readdir(target), []);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test --test-name-pattern="replaces a stale stable workspace directory" test/ssh-workspace.test.ts`

Expected: FAIL because `prepareWorkspaceMountPath` is not exported.

- [ ] **Step 3: Implement safe takeover at the shared mount boundary**

Import `dirname` from `node:path`. Add a private mount-point check based on the mounted directory's device versus its parent, treating only `ENOENT` as absent:

```ts
async function isMountPoint(path: string): Promise<boolean> {
  try {
    const [entry, parent] = await Promise.all([stat(path), stat(dirname(path))]);
    return entry.dev !== parent.dev;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
```

Export `prepareWorkspaceMountPath()` with this sequence:

```ts
export async function prepareWorkspaceMountPath(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  const command = process.platform === "darwin" ? "umount" : "fusermount3";
  const args = process.platform === "darwin" ? ["-f", path] : ["-uz", path];
  await runFile(command, args, STOP_TIMEOUT_MS).catch(() => {});
  if (await isMountPoint(path)) {
    throw new Error(`Termia SSH workspace remains mounted after takeover: ${path}`);
  }
  await rm(path, { recursive: true, force: true });
  await mkdir(path, { mode: 0o700 });
}
```

Replace the current `mkdir`/`EEXIST` rejection in `WorkspaceMount.mount()` with `await prepareWorkspaceMountPath(mountRoot)`.

- [ ] **Step 4: Run focused and full verification**

Run:

```bash
node --test test/ssh-workspace.test.ts
npm run typecheck
node --test --test-reporter=dot test/*.test.ts
git diff --check
```

Expected: all commands exit `0`.

- [ ] **Step 5: Commit**

```bash
git add extensions/termia/ssh-workspace.ts test/ssh-workspace.test.ts
git commit -m "fix: take over stale SSH workspace mounts"
```
