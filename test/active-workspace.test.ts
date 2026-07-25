import assert from "node:assert/strict";
import test from "node:test";
import type { IdentityOpenEvent } from "../extensions/termia/protocol.ts";
import type {
  IdentityOperations,
  MountOperations,
} from "../extensions/termia/ssh-workspace.ts";
import {
  createActiveWorkspace,
  type DetachedCommandOperations,
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
  async open(
    _event: IdentityOpenEvent,
    _parentHops: readonly SshHop[],
    _privateKey: string,
  ): Promise<SshHop> {
    throw new Error("identity routing is not used in this test");
  }

  async close(_shellId: string): Promise<void> {}
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
