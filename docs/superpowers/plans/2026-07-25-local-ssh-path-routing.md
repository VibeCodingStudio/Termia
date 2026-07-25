# Local and SSH Path Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve normal local absolute paths while routing relative and explicit `ssh://` file-tool paths to the active Termia SSH workspace.

**Architecture:** `workspace.ts` owns the complete path contract and prompt presentation. `index.ts` passes Pi's structured skill list into that layer; the existing tool hook remains the single routing boundary.

**Tech Stack:** TypeScript, Node.js URL/path APIs, Pi extension events, Node test runner

## Global Constraints

- Relative file-tool paths use the active remote cwd while SSH is active.
- Unqualified absolute filesystem paths remain local.
- Remote absolute file-tool paths use `ssh://user@host/path` and must match the active leaf.
- Bash keeps its current active-workspace behavior.
- Do not add `file://`, `@file`, dependencies, tools, or TUI behavior.
- Do not change PTY, SSH connection, mount lifecycle, session, history, or publishing code.

---

### Task 1: Route local, relative remote, and explicit SSH paths

**Files:**
- Modify: `extensions/termia/workspace.ts`
- Modify: `test/workspace.test.ts`
- Modify: `test/workspace-tools.test.ts`

**Interfaces:**
- Consumes: `WorkspaceBinding`, a file-tool path, and the active SSH health state.
- Produces: A local physical path, an SSHFS physical path, or a precise routing error.

- [ ] **Step 1: Replace the old projection expectations with failing routing tests**

Update `test/workspace.test.ts` so the path test asserts:

```ts
test("routes local absolute and remote relative or SSH paths", () => {
  const binding = sshWorkspace(hops, "/srv/app", "/tmp/mount-b");
  assert.equal(projectWorkspacePath(binding, "/etc/hosts"), "/etc/hosts");
  assert.equal(projectWorkspacePath(binding, "src/index.ts"), "src/index.ts");
  assert.equal(
    projectWorkspacePath(binding, "ssh://bob@10.0.0.20:2222/etc/hosts"),
    "/tmp/mount-b/etc/hosts",
  );
  assert.equal(
    projectWorkspacePath(binding, "../../../../etc/hosts"),
    "/tmp/mount-b/etc/hosts",
  );
  assert.equal(
    projectWorkspacePath(binding, "/tmp/mount-b/srv/app/index.ts"),
    "/tmp/mount-b/srv/app/index.ts",
  );
  assert.throws(
    () => projectWorkspacePath(binding, "ssh://alice@10.0.0.10/etc/hosts"),
    /does not match active SSH workspace/,
  );
  assert.throws(() => projectWorkspacePath(binding, "ssh://%/bad"), /Invalid SSH workspace URI/);
  assert.throws(() => projectWorkspacePath(binding, "file:///etc/hosts"), /Unsupported workspace URI/);
  assert.throws(() => projectWorkspacePath(binding, "bad\0path"), /NUL/);
});
```

Extend the local-binding test with:

```ts
assert.throws(
  () => projectWorkspacePath(binding, "ssh://bob@10.0.0.20/etc/hosts"),
  /no active SSH workspace/,
);
```

Replace the file-tool tests with cases proving:

```ts
test("keeps local absolute file-tool paths on the host", () => {
  for (const toolName of ["read", "edit", "write", "grep", "find", "ls"] as const) {
    const event = toolEvent(toolName, { path: "/home/klein/.pi/agent/skills/demo/SKILL.md" });
    assert.deepEqual(applyWorkspaceToolPolicy(event, remoteBinding, true), { block: false });
    assert.equal(event.input.path, "/home/klein/.pi/agent/skills/demo/SKILL.md");
  }
});

test("routes relative and explicit SSH file-tool paths to the leaf", () => {
  const relative = toolEvent("read", { path: "src/index.ts" });
  const absolute = toolEvent("read", { path: "ssh://bob@host-b/etc/hosts" });
  applyWorkspaceToolPolicy(relative, remoteBinding, true);
  applyWorkspaceToolPolicy(absolute, remoteBinding, true);
  assert.equal(relative.input.path, "src/index.ts");
  assert.equal(absolute.input.path, "/tmp/mount-b/etc/hosts");
});

test("allows local absolute paths when the SSH leaf is disconnected", () => {
  const local = toolEvent("read", { path: "/home/klein/file" });
  assert.deepEqual(applyWorkspaceToolPolicy(local, remoteBinding, false), { block: false });
  assert.equal(local.input.path, "/home/klein/file");
});
```

Keep disconnected remote, tilde, traversal, and all-tool coverage. Remove every synthetic leading-`@` assertion.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
node --test test/workspace.test.ts test/workspace-tools.test.ts
```

Expected: failures show that absolute paths are still projected, `ssh://` is not parsed, and disconnected local reads are still blocked.

- [ ] **Step 3: Implement the minimal path router**

In `extensions/termia/workspace.ts`:

- Remove leading-`@` stripping.
- Add helpers that reject unsupported URI schemes, parse an `ssh://` URL, normalize the requested and active user/host/port, reject credentials/query/fragment anomalies, and decode the URI pathname.
- Make `projectWorkspacePath()` apply this order:
  1. reject NUL;
  2. reject or route `ssh://`;
  3. return local absolute paths unchanged;
  4. preserve safe relative paths under `piCwd`;
  5. clamp escaping relative paths to the mounted remote root.
- Make `applyWorkspaceToolPolicy()` classify file paths before checking SSH health. Local absolute paths bypass the health check; relative and `ssh://` paths require a healthy leaf. Bash continues to require a healthy leaf.

The implementation must use the existing `workspaceUri()` as the canonical active authority and Node's `URL`, `decodeURIComponent`, and path functions. Do not introduce a new routing class or dependency.

- [ ] **Step 4: Run the focused tests and verify they pass**

Run:

```bash
node --test test/workspace.test.ts test/workspace-tools.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 5: Commit the path router**

```bash
git add extensions/termia/workspace.ts test/workspace.test.ts test/workspace-tools.test.ts
git commit -m "fix: distinguish local and ssh paths"
```

---

### Task 2: Present local and remote skill paths correctly

**Files:**
- Modify: `extensions/termia/workspace.ts`
- Modify: `extensions/termia/index.ts`
- Modify: `test/workspace.test.ts`

**Interfaces:**
- Consumes: `before_agent_start.systemPrompt`, `systemPromptOptions.skills`, and the active binding.
- Produces: A prompt containing a logical SSH cwd, concise path rules, untouched local skill paths, and logical `ssh://` remote skill paths.

- [ ] **Step 1: Add failing prompt-presentation tests**

Extend the existing prompt test in `test/workspace.test.ts`:

```ts
const localSkill = "/home/klein/.pi/agent/npm/node_modules/demo/skills/local/SKILL.md";
const remoteSkill = "/tmp/mount-b/srv/app/.agents/skills/remote/SKILL.md";
const prompt = presentWorkspaceCwd(
  `Skills:\n${localSkill}\n${remoteSkill}\nCurrent working directory: ${binding.piCwd}`,
  binding,
  [{ filePath: localSkill }, { filePath: remoteSkill }],
);

assert.match(prompt, /relative file paths use the active SSH cwd/i);
assert.match(prompt, /local absolute paths stay local/i);
assert.match(prompt, /remote absolute paths use ssh:\/\//i);
assert.match(prompt, new RegExp(localSkill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
assert.match(prompt, /ssh:\/\/bob@10\.0\.0\.20:2222\/srv\/app\/\.agents\/skills\/remote\/SKILL\.md/);
assert.doesNotMatch(prompt, /\/tmp\/mount-b/);
```

- [ ] **Step 2: Run the prompt test and verify it fails**

Run:

```bash
node --test test/workspace.test.ts
```

Expected: `presentWorkspaceCwd()` does not yet accept skills, add guidance, or rewrite the mounted skill path.

- [ ] **Step 3: Implement prompt presentation**

Extend `presentWorkspaceCwd()` with an optional
`readonly { filePath: string }[]` parameter. For SSH bindings:

- Rewrite only skill paths contained by `mountRoot` to a URI built from the active `workspaceUri()` authority and their mount-relative remote path.
- Leave every local skill path unchanged.
- Replace the physical cwd with the logical SSH cwd and the three concise path rules.

Update `extensions/termia/index.ts` to pass
`event.systemPromptOptions.skills` into `presentWorkspaceCwd()`. Do not scan the filesystem or persist a skill allowlist.

- [ ] **Step 4: Run focused and full verification**

Run:

```bash
node --test test/workspace.test.ts test/workspace-tools.test.ts
npm run typecheck
npm test
git diff --check
```

Expected: focused tests pass; the full suite reports zero failures; typecheck and whitespace checks succeed.

- [ ] **Step 5: Commit prompt presentation**

```bash
git add extensions/termia/workspace.ts extensions/termia/index.ts test/workspace.test.ts
git commit -m "fix: present local and remote skill paths"
```
