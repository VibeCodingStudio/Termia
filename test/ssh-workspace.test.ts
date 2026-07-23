import assert from "node:assert/strict";
import test from "node:test";
import type { SshOpenEvent } from "../extensions/termia/protocol.ts";
import {
  buildSftpBridgeScript,
  SshChain,
  workspaceMountName,
  workspaceMountPath,
  type MountOperations,
} from "../extensions/termia/ssh-workspace.ts";
import {
  fileWorkspace,
  sshWorkspace,
  workspaceUri,
  type SshHop,
  type WorkspaceBinding,
} from "../extensions/termia/workspace.ts";

const openA: SshOpenEvent = {
  type: "sshOpen",
  parentShellId: "local",
  shellId: "shell-a",
  destination: "host-a",
  user: "alice",
  host: "10.0.0.10",
  port: 22,
  controlPath: "/tmp/termia-a/control",
  cwd: "/home/alice",
};

const openB: SshOpenEvent = {
  type: "sshOpen",
  parentShellId: "shell-a",
  shellId: "shell-b",
  destination: "host-b",
  user: "bob",
  host: "10.0.0.20",
  port: 2222,
  controlPath: "/tmp/termia-b/control",
  cwd: "/srv/app",
};

const hops: SshHop[] = [openA, openB].map(({ type: _type, cwd: _cwd, ...hop }) => hop);

class FakeMounts implements MountOperations {
  readonly unmounted: string[] = [];
  readonly failedShellId: string | undefined;
  private readonly bindings = new Map<string, WorkspaceBinding>();

  constructor(failedShellId?: string) {
    this.failedShellId = failedShellId;
  }

  async mount(chain: readonly SshHop[], cwd: string): Promise<WorkspaceBinding> {
    const shellId = chain.at(-1)?.shellId;
    if (shellId === undefined) throw new Error("missing leaf");
    if (shellId === this.failedShellId) throw new Error("SFTP unavailable");
    const binding = sshWorkspace(chain, cwd, `/tmp/mount-${shellId}`);
    this.bindings.set(shellId, binding);
    return binding;
  }

  updateCwd(binding: WorkspaceBinding, cwd: string): WorkspaceBinding {
    if (binding.target.scheme !== "ssh" || binding.mountRoot === undefined) return binding;
    return sshWorkspace(binding.target.hops, cwd, binding.mountRoot);
  }

  health(shellId: string): boolean {
    return shellId !== this.failedShellId && this.bindings.has(shellId);
  }

  async unmount(shellId: string): Promise<void> {
    this.bindings.delete(shellId);
    this.unmounted.push(shellId);
  }

  async dispose(): Promise<void> {
    this.bindings.clear();
  }
}

test("builds an SFTP relay through control sockets owned by each parent", () => {
  const script = buildSftpBridgeScript(hops);
  assert.match(script, /^#!\/bin\/sh\nexec ssh /);
  assert.match(script, /\/tmp\/termia-a\/control/);
  assert.match(script, /host-a/);
  assert.match(script, /\/tmp\/termia-b\/control/);
  assert.match(script, /host-b/);
  assert.match(script, /-s .*sftp/);
  assert.doesNotMatch(script, /IdentityFile|private.key|reconnect/);
});

test("names mount directories by hop depth and leaf identity", () => {
  assert.equal(workspaceMountName([hops[0]!]), "1-alice@10.0.0.10");
  assert.equal(workspaceMountName(hops), "2-bob@10.0.0.20-p2222");
  assert.equal(
    workspaceMountName([{ ...hops[0]!, user: "../root", host: "bad/host" }]),
    "1-.._root@bad_host",
  );
});

test("mounts the remote root directly at the named workspace directory", () => {
  assert.equal(workspaceMountPath("/tmp/termia-ssh", hops), "/tmp/termia-ssh/2-bob@10.0.0.20-p2222");
});

test("quotes untrusted hop metadata exactly once", () => {
  const script = buildSftpBridgeScript([{
    ...hops[0]!,
    destination: "host'; touch /tmp/pwn; printf '",
    controlPath: "/tmp/control path/socket",
  }]);
  assert.match(script, /'host'\\''; touch \/tmp\/pwn; printf '\\'''/);
  assert.match(script, /'\/tmp\/control path\/socket'/);
  assert.throws(() => buildSftpBridgeScript([{ ...hops[0]!, destination: "bad\nname" }]), /newline/);
  assert.throws(() => buildSftpBridgeScript([{ ...hops[0]!, controlPath: "/bad\0path" }]), /NUL/);
});

test("pushes only from the current leaf and pops to the retained parent", async () => {
  const mounts = new FakeMounts();
  const chain = new SshChain(fileWorkspace("/work/project"), "local", mounts);
  chain.open(openA);
  chain.open(openB);
  assert.equal(
    workspaceUri((await chain.readyBinding("shell-b")).target),
    "ssh://bob@10.0.0.20:2222/srv/app",
  );
  assert.throws(
    () => chain.open({ ...openA, parentShellId: "local", shellId: "side" }),
    /current leaf/,
  );
  await chain.close("shell-b");
  assert.equal(workspaceUri(chain.currentBinding.target), "ssh://alice@10.0.0.10/home/alice");
  assert.deepEqual(mounts.unmounted, ["shell-b"]);
});

test("updates a mounted leaf cwd without remounting", async () => {
  const mounts = new FakeMounts();
  const chain = new SshChain(fileWorkspace("/work/project"), "local", mounts);
  chain.open(openA);
  await chain.readyBinding("shell-a");
  chain.updateCwd("shell-a", "/srv/new");
  assert.equal(chain.currentBinding.piCwd, "/tmp/mount-shell-a/srv/new");
  assert.equal(chain.contextFor("shell-a").workspaceUri, "ssh://alice@10.0.0.10/srv/new");
});

test("validates PTY cwd against the matching hop even after its mount drops", async () => {
  const mounts = new FakeMounts();
  const chain = new SshChain(fileWorkspace("/work/project"), "local", mounts);
  chain.open(openA);
  await chain.readyBinding("shell-a");

  assert.doesNotThrow(() => chain.assertPhysicalWorkspace("/tmp/mount-shell-a/home/alice/src"));
  assert.throws(() => chain.assertPhysicalWorkspace("/tmp/different-mount"), /outside the active workspace/);
  await mounts.unmount("shell-a");
  assert.throws(
    () => chain.assertPhysicalWorkspace("/tmp/mount-shell-a/home/alice"),
    /SSH workspace is disconnected/,
  );
});

test("retains the previous binding when the leaf mount fails", async () => {
  const mounts = new FakeMounts("shell-b");
  const chain = new SshChain(fileWorkspace("/work/project"), "local", mounts);
  chain.open(openA);
  await chain.readyBinding("shell-a");
  chain.open(openB);
  await assert.rejects(() => chain.readyBinding("shell-b"), /SFTP unavailable/);
  assert.equal(
    workspaceUri(chain.nearestLiveBinding().target),
    "ssh://alice@10.0.0.10/home/alice",
  );
});

test("returns to the latest local cwd after the final hop closes", async () => {
  const chain = new SshChain(fileWorkspace("/work/project"), "local", new FakeMounts());
  chain.updateCwd("local", "/work/other");
  chain.open(openA);
  await chain.readyBinding("shell-a");
  await chain.close("shell-a");
  assert.equal(chain.currentBinding.piCwd, "/work/other");
});

test("waits for a pending mount before unmounting a fast-closing hop", async () => {
  let finishMount: ((binding: WorkspaceBinding) => void) | undefined;
  let mounted = false;
  const mounts: MountOperations = {
    mount: (chain, cwd) => new Promise<WorkspaceBinding>((resolveMount) => {
      finishMount = (binding) => {
        mounted = true;
        resolveMount(binding);
      };
      assert.equal(chain.at(-1)?.shellId, "shell-a");
      assert.equal(cwd, "/home/alice");
    }),
    updateCwd: (binding) => binding,
    health: () => mounted,
    unmount: async () => {
      assert.equal(mounted, true);
      mounted = false;
    },
    dispose: async () => {},
  };
  const chain = new SshChain(fileWorkspace("/work/project"), "local", mounts);
  chain.open(openA);
  const closing = chain.close("shell-a");
  finishMount?.(sshWorkspace([hops[0]!], "/home/alice", "/tmp/mount-shell-a"));
  await closing;
  assert.equal(chain.currentBinding.piCwd, "/work/project");
});
