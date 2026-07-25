import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import type { IdentityOpenEvent } from "../extensions/termia/protocol.ts";
import type {
  IdentityOperations,
  MountOperations,
} from "../extensions/termia/ssh-workspace.ts";
import {
  createActiveWorkspace,
  StaleWorkspaceAccessError,
  type DetachedCommandOperations,
  WorkspacePathError,
  WorkspaceUnavailableError,
} from "../extensions/termia/active-workspace.ts";
import {
  sshWorkspace,
  type SshHop,
  type WorkspaceBinding,
} from "../extensions/termia/workspace.ts";

class MemoryMounts implements MountOperations {
  private readonly healthy = new Map<string, boolean>();
  private readonly failures = new Map<string, string>();
  disposeCount = 0;

  failMount(shellId: string, reason: string): void {
    this.failures.set(shellId, reason);
  }

  setHealthy(shellId: string, healthy: boolean): void {
    this.healthy.set(shellId, healthy);
  }

  async mount(hops: readonly SshHop[], cwd: string): Promise<WorkspaceBinding> {
    const shellId = hops.at(-1)?.shellId;
    if (shellId === undefined) throw new Error("missing test shell");
    const failure = this.failures.get(shellId);
    if (failure !== undefined) throw new Error(failure);
    this.healthy.set(shellId, true);
    return sshWorkspace(hops, cwd, "/tmp/termia-test-mount");
  }

  updateCwd(binding: WorkspaceBinding, cwd: string): WorkspaceBinding {
    if (binding.target.scheme !== "ssh" || binding.mountRoot === undefined) return binding;
    return sshWorkspace(binding.target.hops, cwd, binding.mountRoot);
  }

  async unmount(shellId: string): Promise<void> {
    this.healthy.set(shellId, false);
  }

  health(shellId: string): boolean {
    return this.healthy.get(shellId) === true;
  }

  async dispose(): Promise<void> {
    this.disposeCount += 1;
    this.healthy.clear();
  }
}

class MemoryIdentities implements IdentityOperations {
  privateKey: string | undefined;
  readonly closed: string[] = [];

  async open(
    event: IdentityOpenEvent,
    parentHops: readonly SshHop[],
    privateKey: string,
  ): Promise<SshHop> {
    const parent = parentHops.at(-1);
    if (parent === undefined) throw new Error("missing identity parent");
    this.privateKey = privateKey;
    return {
      shellId: event.shellId,
      parentShellId: event.parentShellId,
      destination: `${event.user}@termia-identity-${event.shellId}`,
      user: event.user,
      host: parent.host,
      port: parent.port,
      controlPath: `/tmp/termia-identity-${event.shellId}/control`,
      localAnchor: true,
    };
  }

  async close(shellId: string): Promise<void> {
    this.closed.push(shellId);
  }
  async dispose(): Promise<void> {}
}

function fakeDetached(): DetachedCommandOperations {
  return {
    run: async () => ({ exitCode: 0 }),
  };
}

test("keeps Active unchanged until a prepared SSH workspace commits", async (t) => {
  const { workspace, terminal } = createActiveWorkspace(
    "/work/project",
    fakeDetached(),
    new MemoryMounts(),
    new MemoryIdentities(),
  );
  t.after(() => workspace[Symbol.asyncDispose]());
  terminal.resetRoot("/work/project", "local");
  terminal.openSsh({
    type: "sshOpen",
    shellId: "remote",
    parentShellId: "local",
    destination: "server",
    user: "klein",
    host: "server",
    port: 22,
    controlPath: "/tmp/termia-test-control",
    cwd: "/srv/app",
  });

  const activation = await workspace.prepare("remote");
  assert.equal(activation.kind, "ready");
  assert.equal(workspace.current().summary.uri, "file:///work/project");
  assert.equal(activation.pending.uri, "ssh://klein@server/srv/app");

  const committed = activation.commit();
  assert.equal(committed.uri, "ssh://klein@server/srv/app");
  assert.equal(workspace.current().summary.uri, "ssh://klein@server/srv/app");
});

test("retains a deferred candidate as Pending without changing Active", async (t) => {
  const { workspace, terminal } = createActiveWorkspace(
    "/work/project",
    fakeDetached(),
    new MemoryMounts(),
    new MemoryIdentities(),
  );
  t.after(() => workspace[Symbol.asyncDispose]());
  terminal.resetRoot("/work/project", "local");
  terminal.openSsh({
    type: "sshOpen",
    shellId: "remote",
    parentShellId: "local",
    destination: "server",
    user: "klein",
    host: "server",
    port: 22,
    controlPath: "/tmp/termia-test-control",
    cwd: "/srv/app",
  });

  const first = await workspace.prepare("remote");
  assert.equal(first.kind, "ready");
  const deferred = first.defer("Pi session handoff was cancelled");
  assert.equal(deferred.readiness, "deferred");
  assert.equal(deferred.reason, "Pi session handoff was cancelled");
  assert.equal(workspace.current().summary.uri, "file:///work/project");

  const retry = await workspace.prepare("remote");
  assert.equal(retry.kind, "ready");
  assert.equal(retry.pending.uri, "ssh://klein@server/srv/app");
});

test("rejects a ready ticket after terminal topology changes", async (t) => {
  const { workspace, terminal } = createActiveWorkspace(
    "/work/project",
    fakeDetached(),
    new MemoryMounts(),
    new MemoryIdentities(),
  );
  t.after(() => workspace[Symbol.asyncDispose]());
  terminal.resetRoot("/work/project", "local");
  terminal.openSsh({
    type: "sshOpen",
    shellId: "remote",
    parentShellId: "local",
    destination: "server",
    user: "klein",
    host: "server",
    port: 22,
    controlPath: "/tmp/termia-test-control",
    cwd: "/srv/app",
  });
  const activation = await workspace.prepare("remote");
  assert.equal(activation.kind, "ready");

  terminal.updateCwd("remote", "/srv/other");
  assert.throws(() => activation.commit(), /stale Active Workspace activation/);
  assert.equal(workspace.current().summary.uri, "file:///work/project");
});

test("reports a failed mount as Pending and preserves Active", async (t) => {
  const mounts = new MemoryMounts();
  mounts.failMount("remote", "test mount denied");
  const { workspace, terminal } = createActiveWorkspace(
    "/work/project",
    fakeDetached(),
    mounts,
    new MemoryIdentities(),
  );
  t.after(() => workspace[Symbol.asyncDispose]());
  terminal.resetRoot("/work/project", "local");
  terminal.openSsh({
    type: "sshOpen",
    shellId: "remote",
    parentShellId: "local",
    destination: "server",
    user: "klein",
    host: "server",
    port: 22,
    controlPath: "/tmp/termia-test-control",
    cwd: "/srv/app",
  });

  const activation = await workspace.prepare("remote");
  assert.equal(activation.kind, "pending");
  assert.equal(activation.pending.uri, "ssh://klein@server/srv/app");
  assert.equal(activation.pending.readiness, "blocked");
  assert.match(activation.pending.reason ?? "", /test mount denied/);
  assert.equal(workspace.current().summary.uri, "file:///work/project");
});

test("does not promote an ancestor until its real close event is committed", async (t) => {
  const { workspace, terminal } = createActiveWorkspace(
    "/work/project",
    fakeDetached(),
    new MemoryMounts(),
    new MemoryIdentities(),
  );
  t.after(() => workspace[Symbol.asyncDispose]());
  terminal.resetRoot("/work/project", "local");
  terminal.openSsh({
    type: "sshOpen",
    shellId: "parent",
    parentShellId: "local",
    destination: "parent",
    user: "alice",
    host: "parent",
    port: 22,
    controlPath: "/tmp/termia-parent-control",
    cwd: "/home/alice",
  });
  terminal.openSsh({
    type: "sshOpen",
    shellId: "leaf",
    parentShellId: "parent",
    destination: "leaf",
    user: "bob",
    host: "leaf",
    port: 22,
    controlPath: "/tmp/termia-leaf-control",
    cwd: "/srv/app",
  });
  const leaf = await workspace.prepare("leaf");
  assert.equal(leaf.kind, "ready");
  leaf.commit();

  await terminal.close("leaf");
  assert.equal(workspace.current().summary.uri, "ssh://bob@leaf/srv/app");
  const parent = await workspace.prepare("parent");
  assert.equal(parent.kind, "ready");
  assert.equal(workspace.current().summary.uri, "ssh://bob@leaf/srv/app");
  parent.commit();
  assert.equal(workspace.current().summary.uri, "ssh://alice@parent/home/alice");
});

test("routes an identity workspace through the same prepare and commit boundary", async (t) => {
  const identities = new MemoryIdentities();
  const { workspace, terminal } = createActiveWorkspace(
    "/work/project",
    fakeDetached(),
    new MemoryMounts(),
    identities,
  );
  t.after(() => workspace[Symbol.asyncDispose]());
  terminal.resetRoot("/work/project", "local");
  terminal.openSsh({
    type: "sshOpen",
    shellId: "remote",
    parentShellId: "local",
    destination: "server",
    user: "klein",
    host: "server",
    port: 22,
    controlPath: "/tmp/termia-test-control",
    cwd: "/srv/app",
  });
  terminal.openIdentity({
    type: "identityOpen",
    shellId: "root",
    parentShellId: "remote",
    user: "root",
    cwd: "/root",
    port: 45123,
    hostKey: "ssh-ed25519 AAAA",
  }, "/tmp/termia-private-key");

  const activation = await workspace.prepare("root");
  assert.equal(activation.kind, "ready");
  assert.equal(activation.pending.uri, "ssh://root@server/root");
  assert.equal(workspace.current().summary.uri, "file:///work/project");
  activation.commit();
  assert.equal(workspace.current().summary.uri, "ssh://root@server/root");
  assert.equal(identities.privateKey, "/tmp/termia-private-key");

  await terminal.close("root");
  assert.deepEqual(identities.closed, ["root"]);
});

test("keeps a remote Active identity when the terminal exits", async (t) => {
  const { workspace, terminal } = createActiveWorkspace(
    "/work/project",
    fakeDetached(),
    new MemoryMounts(),
    new MemoryIdentities(),
  );
  t.after(() => workspace[Symbol.asyncDispose]());
  terminal.resetRoot("/work/project", "local");
  terminal.openSsh({
    type: "sshOpen",
    shellId: "remote",
    parentShellId: "local",
    destination: "server",
    user: "klein",
    host: "server",
    port: 22,
    controlPath: "/tmp/termia-test-control",
    cwd: "/srv/app",
  });
  const activation = await workspace.prepare("remote");
  assert.equal(activation.kind, "ready");
  activation.commit();

  await terminal.terminalExited();
  const active = workspace.current().summary;
  assert.equal(active.uri, "ssh://klein@server/srv/app");
  assert.equal(active.availability.kind, "unavailable");
});

test("disposes Active Workspace resources exactly once", async () => {
  const mounts = new MemoryMounts();
  const { workspace } = createActiveWorkspace(
    "/work/project",
    fakeDetached(),
    mounts,
    new MemoryIdentities(),
  );

  await workspace[Symbol.asyncDispose]();
  await workspace[Symbol.asyncDispose]();

  assert.equal(mounts.disposeCount, 1);
});

test("routes Agent file paths through the committed Active Workspace", async (t) => {
  const { workspace, terminal } = createActiveWorkspace(
    "/work/project",
    fakeDetached(),
    new MemoryMounts(),
    new MemoryIdentities(),
  );
  t.after(() => workspace[Symbol.asyncDispose]());
  terminal.resetRoot("/work/project", "local");
  terminal.openSsh({
    type: "sshOpen",
    shellId: "remote",
    parentShellId: "local",
    destination: "server",
    user: "klein",
    host: "server",
    port: 22,
    controlPath: "/tmp/termia-test-control",
    cwd: "/srv/app",
  });
  const activation = await workspace.prepare("remote");
  assert.equal(activation.kind, "ready");
  activation.commit();
  const access = workspace.current();

  assert.equal(access.filePath("src/index.ts"), "src/index.ts");
  assert.equal(access.filePath("/etc/hosts"), "/etc/hosts");
  assert.equal(
    access.filePath("ssh://klein@server/etc/hosts"),
    "/tmp/termia-test-mount/etc/hosts",
  );
});

test("rejects unsafe remote path inputs with WorkspacePathError", async (t) => {
  const { workspace, terminal } = createActiveWorkspace(
    "/work/project",
    fakeDetached(),
    new MemoryMounts(),
    new MemoryIdentities(),
  );
  t.after(() => workspace[Symbol.asyncDispose]());
  terminal.resetRoot("/work/project", "local");
  terminal.openSsh({
    type: "sshOpen",
    shellId: "remote",
    parentShellId: "local",
    destination: "server",
    user: "klein",
    host: "server",
    port: 22,
    controlPath: "/tmp/termia-test-control",
    cwd: "/srv/app",
  });
  const activation = await workspace.prepare("remote");
  assert.equal(activation.kind, "ready");
  activation.commit();
  const access = workspace.current();

  assert.throws(
    () => access.filePath("~/.ssh/config"),
    (error) => error instanceof WorkspacePathError && /cannot map ~ paths safely/.test(error.message),
  );
  assert.throws(
    () => access.filePath("ssh://other@server/etc/hosts"),
    (error) => error instanceof WorkspacePathError && /does not match/.test(error.message),
  );
  assert.throws(
    () => access.filePath("bad\0path"),
    (error) => error instanceof WorkspacePathError && /NUL/.test(error.message),
  );
});

test("blocks remote files but permits local absolute files while Active is unavailable", async (t) => {
  const mounts = new MemoryMounts();
  const { workspace, terminal } = createActiveWorkspace(
    "/work/project",
    fakeDetached(),
    mounts,
    new MemoryIdentities(),
  );
  t.after(() => workspace[Symbol.asyncDispose]());
  terminal.resetRoot("/work/project", "local");
  terminal.openSsh({
    type: "sshOpen",
    shellId: "remote",
    parentShellId: "local",
    destination: "server",
    user: "klein",
    host: "server",
    port: 22,
    controlPath: "/tmp/termia-test-control",
    cwd: "/srv/app",
  });
  const activation = await workspace.prepare("remote");
  assert.equal(activation.kind, "ready");
  activation.commit();
  const available = workspace.current();
  mounts.setHealthy("remote", false);
  const unavailable = workspace.current();

  assert.equal(unavailable.summary.uri, "ssh://klein@server/srv/app");
  assert.equal(unavailable.summary.availability.kind, "unavailable");
  assert.notEqual(unavailable.summary.generation, available.summary.generation);
  assert.equal(unavailable.filePath("/home/klein/local.txt"), "/home/klein/local.txt");
  assert.throws(
    () => unavailable.filePath("src/index.ts"),
    (error) => error instanceof WorkspaceUnavailableError
      && /ssh:\/\/klein@server\/srv\/app/.test(error.message)
      && /\/termia reset/.test(error.message),
  );
  assert.throws(
    () => unavailable.filePath("ssh://klein@server/etc/hosts"),
    WorkspaceUnavailableError,
  );
  assert.equal(unavailable.executionDirectory(), "/tmp/termia-test-mount/srv/app");
  assert.throws(() => available.executionDirectory(), StaleWorkspaceAccessError);
  await assert.rejects(
    unavailable.runDetached({
      command: "pwd",
      cwd: unavailable.executionDirectory(),
      options: { onData: () => {} },
    }),
    WorkspaceUnavailableError,
  );
});

test("delegates remote detached Bash through an encoded SSH command", async (t) => {
  let delegated: { command: string; cwd: string; timeout: number | undefined } | undefined;
  const detached: DetachedCommandOperations = {
    run: async ({ command, cwd, options }) => {
      delegated = { command, cwd, timeout: options.timeout };
      options.onData(Buffer.from("remote-output"));
      return { exitCode: 7 };
    },
  };
  const { workspace, terminal } = createActiveWorkspace(
    "/work/project",
    detached,
    new MemoryMounts(),
    new MemoryIdentities(),
  );
  t.after(() => workspace[Symbol.asyncDispose]());
  terminal.resetRoot("/work/project", "local");
  terminal.openSsh({
    type: "sshOpen",
    shellId: "remote",
    parentShellId: "local",
    destination: "server",
    user: "klein",
    host: "server",
    port: 22,
    controlPath: "/tmp/termia-test-control",
    cwd: "/srv/app",
  });
  const activation = await workspace.prepare("remote");
  assert.equal(activation.kind, "ready");
  activation.commit();
  const access = workspace.current();
  const output: Buffer[] = [];

  const result = await access.runDetached({
    command: "printf 'hello'\nread value",
    cwd: access.executionDirectory(),
    options: { onData: (data) => output.push(data), timeout: 12 },
  });

  assert.equal(result.exitCode, 7);
  assert.equal(Buffer.concat(output).toString(), "remote-output");
  assert.equal(delegated?.cwd, "/tmp/termia-test-mount/srv/app");
  assert.equal(delegated?.timeout, 12);
  assert.match(delegated?.command ?? "", /ssh -T -S/);
  assert.match(delegated?.command ?? "", /\/srv\/app/);
  assert.doesNotMatch(delegated?.command ?? "", /read value/);
});

test("presents logical SSH cwd and remote skill paths without exposing mount roots", async (t) => {
  const { workspace, terminal } = createActiveWorkspace(
    "/work/project",
    fakeDetached(),
    new MemoryMounts(),
    new MemoryIdentities(),
  );
  t.after(() => workspace[Symbol.asyncDispose]());
  terminal.resetRoot("/work/project", "local");
  terminal.openSsh({
    type: "sshOpen",
    shellId: "remote",
    parentShellId: "local",
    destination: "server",
    user: "klein",
    host: "server",
    port: 22,
    controlPath: "/tmp/termia-test-control",
    cwd: "/srv/app",
  });
  const activation = await workspace.prepare("remote");
  assert.equal(activation.kind, "ready");
  activation.commit();
  const access = workspace.current();
  const localSkill = "/home/klein/.pi/agent/skills/local/SKILL.md";
  const remoteSkill = "/tmp/termia-test-mount/srv/app/.agents/skills/remote/SKILL.md";
  const skills = [{ filePath: localSkill }, { filePath: remoteSkill }];

  const presented = access.present({
    systemPrompt: `Skills:\n${localSkill}\n${remoteSkill}\nCurrent working directory: ${access.executionDirectory()}`,
    skills,
  });

  assert.equal(presented.skills, skills);
  assert.match(presented.systemPrompt, /Current working directory: ssh:\/\/klein@server\/srv\/app/);
  assert.match(presented.systemPrompt, /relative file paths use the active SSH cwd/i);
  assert.match(presented.systemPrompt, /local absolute paths stay local/i);
  assert.match(presented.systemPrompt, /remote absolute paths use ssh:\/\//i);
  assert.ok(presented.systemPrompt.includes(localSkill));
  assert.match(
    presented.systemPrompt,
    /ssh:\/\/klein@server\/srv\/app\/\.agents\/skills\/remote\/SKILL\.md/,
  );
  assert.doesNotMatch(presented.systemPrompt, /\/tmp\/termia-test-mount/);
});

test("runs local detached Bash without a terminal or controlling tty", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "termia-active-local-"));
  const cwd = join(root, "cwd");
  mkdirSync(cwd);
  const local = createLocalBashOperations();
  const { workspace } = createActiveWorkspace(cwd, {
    run: ({ command, cwd: commandCwd, options }) =>
      local.exec(command, commandCwd, options),
  });
  t.after(async () => {
    await workspace[Symbol.asyncDispose]();
    rmSync(root, { recursive: true, force: true });
  });
  const access = workspace.current();
  const output: Buffer[] = [];

  const result = await access.runDetached({
    command: "if [ -t 0 ]; then echo tty; else echo no-tty; fi; if (exec 3</dev/tty) 2>/dev/null; then echo controlling-tty; else echo no-controlling-tty; fi; IFS= read -r value || echo eof",
    cwd,
    options: { onData: (data) => output.push(data) },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(Buffer.concat(output).toString(), "no-tty\nno-controlling-tty\neof\n");
});

test("keeps concurrent local detached Bash cancellation isolated", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "termia-active-abort-"));
  const local = createLocalBashOperations();
  const { workspace } = createActiveWorkspace(root, {
    run: ({ command, cwd, options }) => local.exec(command, cwd, options),
  });
  t.after(async () => {
    await workspace[Symbol.asyncDispose]();
    rmSync(root, { recursive: true, force: true });
  });
  const access = workspace.current();
  const abort = new AbortController();
  const survivorOutput: Buffer[] = [];
  const killed = access.runDetached({
    command: "printf killed-start; sleep 30",
    cwd: root,
    options: { onData: () => {}, signal: abort.signal },
  });
  const survivor = access.runDetached({
    command: "printf survivor; sleep 0.2; printf done",
    cwd: root,
    options: { onData: (data) => survivorOutput.push(data) },
  });
  setTimeout(() => abort.abort(), 100);

  await assert.rejects(killed, /^Error: aborted$/);
  assert.equal((await survivor).exitCode, 0);
  assert.equal(Buffer.concat(survivorOutput).toString(), "survivordone");
});

test("keeps local detached Bash usable after an isolated timeout", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "termia-active-timeout-"));
  const local = createLocalBashOperations();
  const { workspace } = createActiveWorkspace(root, {
    run: ({ command, cwd, options }) => local.exec(command, cwd, options),
  });
  t.after(async () => {
    await workspace[Symbol.asyncDispose]();
    rmSync(root, { recursive: true, force: true });
  });
  const access = workspace.current();

  await assert.rejects(
    access.runDetached({
      command: "trap '' INT; sleep 30",
      cwd: root,
      options: { onData: () => {}, timeout: 0.1 },
    }),
    /^Error: timeout:0.1$/,
  );
  const output: Buffer[] = [];
  const result = await access.runDetached({
    command: "printf after-timeout",
    cwd: root,
    options: { onData: (data) => output.push(data) },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(Buffer.concat(output).toString(), "after-timeout");
});

test("retains the last verified local cwd for Terminal Reset", async (t) => {
  const facets = createActiveWorkspace("/work/project", fakeDetached());
  t.after(() => facets.workspace[Symbol.asyncDispose]());
  facets.terminal.resetRoot("/work/project", "local-shell");
  facets.terminal.updateCwd("local-shell", "/work/next");

  assert.equal(facets.terminal.localCwd(), "/work/next");
});
