import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { IdentityOpenEvent, SshOpenEvent } from "../extensions/termia/protocol.ts";
import {
  activeRoute,
  buildRemoteBashCommand,
  buildRemoteExecCommand,
  buildRemoteStreamCommand,
  buildSftpBridgeScript,
  IdentityTransport,
  prepareWorkspaceMountPath,
  SshChain,
  WorkspaceMount,
  workspaceMountName,
  workspaceMountPath,
  type IdentityOperations,
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

const openRoot: IdentityOpenEvent = {
  type: "identityOpen",
  parentShellId: "shell-a",
  shellId: "shell-root",
  user: "root",
  cwd: "/root",
  port: 45123,
  hostKey: "ssh-ed25519 AAAA",
};

const hops: SshHop[] = [openA, openB].map(({ type: _type, cwd: _cwd, ...hop }) => hop);

const rootA: SshHop = {
  ...hops[0]!,
  shellId: "shell-root",
  parentShellId: "shell-a",
  destination: "root@termia-identity-shell-root",
  user: "root",
  controlPath: "/tmp/termia-identity/control",
  localAnchor: true,
};

const nestedB: SshHop = {
  ...hops[1]!,
  parentShellId: "shell-root",
};

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

class FakeIdentities implements IdentityOperations {
  readonly closed: string[] = [];
  private readonly fail: boolean;

  constructor(fail = false) {
    this.fail = fail;
  }

  async open(event: IdentityOpenEvent, parentHops: readonly SshHop[]): Promise<SshHop> {
    if (this.fail) throw new Error("identity control failed");
    const parent = parentHops.at(-1)!;
    return {
      shellId: event.shellId,
      parentShellId: event.parentShellId,
      destination: `${event.user}@termia-identity-${event.shellId}`,
      user: event.user,
      host: parent.host,
      port: parent.port,
      controlPath: `/tmp/identity-${event.shellId}/control`,
      localAnchor: true,
    };
  }

  async close(shellId: string): Promise<void> {
    this.closed.push(shellId);
  }

  async dispose(): Promise<void> {}
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

test("builds non-interactive remote Bash through existing control sockets", () => {
  const command = buildRemoteBashCommand(hops, "/srv/app dir", "printf 'one\\ntwo'\nread value");

  assert.match(command, /ssh -T -S '\/tmp\/termia-a\/control'/);
  assert.match(command, /ssh -T -S .*\/tmp\/termia-b\/control/);
  assert.match(command, /exec ssh -T -S/);
  assert.doesNotMatch(command, /exec cd --/);
  assert.match(command, /cd -- .*\/srv\/app dir/);
  assert.match(command, /base64 -d/);
  assert.match(command, /ucode/);
  assert.doesNotMatch(command, /printf 'one\\ntwo'/);
  assert.throws(() => buildRemoteBashCommand(hops, "relative", "true"), /absolute/);
  assert.throws(() => buildRemoteBashCommand(hops, "/srv/app", "bad\0command"), /NUL/);
});

test("starts transport at the newest local route anchor", () => {
  const chain = [hops[0]!, rootA, nestedB];
  assert.deepEqual(activeRoute(chain).map((hop) => hop.shellId), ["shell-root", "shell-b"]);

  const command = buildRemoteExecCommand(chain, "id -un");
  assert.doesNotMatch(command, /termia-a\/control/);
  assert.match(command, /termia-identity\/control/);
  assert.match(command, /termia-b\/control/);
});

test("builds a byte stream through the current route", () => {
  const command = buildRemoteStreamCommand([hops[0]!, rootA, nestedB], "127.0.0.1", 45123);
  assert.doesNotMatch(command, /termia-a\/control/);
  assert.match(command, /termia-identity\/control/);
  assert.match(command, /termia-b\/control/);
  assert.match(command, /-W/);
  assert.match(command, /127\.0\.0\.1:45123/);
});

test("opens a pinned local ControlMaster through the parent SSH route", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "termia-identity-transport-test-"));
  const bin = join(root, "bin");
  const log = join(root, "ssh.log");
  const privateKey = join(root, "identity");
  await mkdir(bin);
  await writeFile(privateKey, "private", { mode: 0o600 });
  await writeFile(join(bin, "ssh"), `#!/bin/sh
for value do printf '%s\n' "$value"; done > "$TERMIA_SSH_TEST_LOG"
exit 0
`, { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  process.env.TERMIA_SSH_TEST_LOG = log;
  const transport = new IdentityTransport();
  t.after(async () => {
    await transport.dispose();
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    delete process.env.TERMIA_SSH_TEST_LOG;
    await rm(root, { recursive: true, force: true });
  });

  const hop = await transport.open(openRoot, [hops[0]!], privateKey);
  const runtime = join(hop.controlPath, "..");
  const args = (await readFile(log, "utf8")).trim().split("\n");
  const files = await readdir(runtime);

  assert.equal((await stat(runtime)).mode & 0o777, 0o700);
  assert.equal(hop.localAnchor, true);
  assert.equal(hop.user, "root");
  assert.equal(hop.host, "10.0.0.10");
  assert.equal(hop.port, 22);
  assert.match(hop.destination, /^root@termia-identity-/);
  assert.ok(args.includes("ControlMaster=yes"));
  assert.ok(args.includes("ControlPersist=no"));
  assert.ok(args.includes("IdentitiesOnly=yes"));
  assert.ok(args.includes("PasswordAuthentication=no"));
  assert.ok(args.includes("KbdInteractiveAuthentication=no"));
  assert.ok(args.includes(privateKey));
  assert.ok(args.some((value) => value.startsWith("ProxyCommand=")));
  const bridge = files.find((name) => name.endsWith(".bridge"));
  const knownHosts = files.find((name) => name.endsWith(".known_hosts"));
  assert.ok(bridge);
  assert.ok(knownHosts);
  assert.equal((await stat(join(runtime, bridge))).mode & 0o777, 0o700);
  assert.equal((await stat(join(runtime, knownHosts))).mode & 0o777, 0o600);
  assert.match(await readFile(join(runtime, bridge), "utf8"), /termia-a\/control.*127\.0\.0\.1:45123/);
  assert.match(await readFile(join(runtime, knownHosts), "utf8"), /ssh-ed25519 AAAA/);
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
  assert.equal(workspaceMountPath(hops), "/tmp/termia-ssh/2-bob@10.0.0.20-p2222");
});

test("reports a missing local sshfs dependency before mounting", async (t) => {
  const path = await mkdtemp(join(tmpdir(), "termia-empty-path-"));
  const previousPath = process.env.PATH;
  process.env.PATH = path;
  t.after(async () => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(path, { recursive: true, force: true });
  });

  await assert.rejects(
    new WorkspaceMount().mount([hops[0]!], "/home/alice"),
    /sshfs is required on the machine running Pi/,
  );
});

test("reports a missing local fusermount3 dependency before mounting on Linux", {
  skip: process.platform === "darwin",
}, async (t) => {
  const path = await mkdtemp(join(tmpdir(), "termia-sshfs-only-path-"));
  const sshfs = join(path, "sshfs");
  await writeFile(sshfs, "#!/bin/sh\nexit 0\n");
  await chmod(sshfs, 0o700);
  const previousPath = process.env.PATH;
  process.env.PATH = path;
  t.after(async () => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(path, { recursive: true, force: true });
  });

  await assert.rejects(
    new WorkspaceMount().mount([hops[0]!], "/home/alice"),
    /fusermount3 is required on the machine running Pi/,
  );
});

test("replaces a stale stable workspace directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "termia-stale-mount-"));
  const target = join(root, "1-alice@host-a");
  await mkdir(target);
  await writeFile(join(target, ".termia-probe-old"), "stale");
  t.after(() => rm(root, { recursive: true, force: true }));

  await prepareWorkspaceMountPath(target);

  assert.deepEqual(await readdir(target), []);
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
  const ready = await chain.readyBinding("shell-b");
  assert.equal(workspaceUri(ready.target), "ssh://bob@10.0.0.20:2222/srv/app");
  assert.equal(
    ready.target.scheme === "ssh"
      ? ready.target.hops[0]?.localAnchor
      : undefined,
    true,
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

test("mounts an identity hop and restores its SSH parent on close", async () => {
  const mounts = new FakeMounts();
  const identities = new FakeIdentities();
  const chain = new SshChain(fileWorkspace("/work/project"), "local", mounts, identities);
  chain.open(openA);
  await chain.readyBinding("shell-a");
  chain.openIdentity(openRoot, "/tmp/private-identity");

  assert.equal(chain.contextFor("shell-root").workspaceUri, "ssh://root@10.0.0.10/root");
  const root = await chain.readyBinding("shell-root");
  assert.equal(workspaceUri(root.target), "ssh://root@10.0.0.10/root");
  assert.equal(root.target.scheme === "ssh" ? root.target.hops.at(-1)?.localAnchor : undefined, true);

  await chain.close("shell-root");
  assert.equal(workspaceUri(chain.currentBinding.target), "ssh://alice@10.0.0.10/home/alice");
  assert.deepEqual(identities.closed, ["shell-root"]);
});

test("does not expose a failed identity hop as the parent identity", async () => {
  const mounts = new FakeMounts();
  const chain = new SshChain(
    fileWorkspace("/work/project"),
    "local",
    mounts,
    new FakeIdentities(true),
  );
  chain.open(openA);
  await chain.readyBinding("shell-a");
  chain.openIdentity(openRoot, "/tmp/private-identity");

  await assert.rejects(() => chain.readyBinding("shell-root"), /identity control failed/);
  assert.equal(workspaceUri(chain.nearestLiveBinding().target), "ssh://alice@10.0.0.10/home/alice");
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
