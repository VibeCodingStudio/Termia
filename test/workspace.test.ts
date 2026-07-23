import assert from "node:assert/strict";
import test from "node:test";
import {
  fileWorkspace,
  presentWorkspaceCwd,
  projectWorkspacePath,
  sshWorkspace,
  workspaceUri,
  type SshHop,
} from "../extensions/termia/workspace.ts";

const hops: SshHop[] = [
  {
    shellId: "shell-a",
    parentShellId: "local",
    destination: "host-a",
    user: "alice",
    host: "10.0.0.10",
    port: 22,
    controlPath: "/tmp/termia-a/control",
  },
  {
    shellId: "shell-b",
    parentShellId: "shell-a",
    destination: "host-b",
    user: "bob",
    host: "10.0.0.20",
    port: 2222,
    controlPath: "/tmp/termia-b/control",
  },
];

test("formats the leaf URI and keeps the complete hop chain", () => {
  const binding = sshWorkspace(hops, "/srv/app", "/tmp/mount-b");
  assert.equal(workspaceUri(binding.target), "ssh://bob@10.0.0.20:2222/srv/app");
  assert.deepEqual(binding.target.scheme === "ssh" ? binding.target.hops : [], hops);
  assert.equal(binding.piCwd, "/tmp/mount-b/srv/app");
});

test("formats IPv6 SSH authorities", () => {
  const binding = sshWorkspace([{ ...hops[0]!, host: "2001:db8::1" }], "/work", "/tmp/mount-a");
  assert.equal(workspaceUri(binding.target), "ssh://alice@[2001:db8::1]/work");
});

test("projects absolute remote paths and @file paths without escaping the mount", () => {
  const binding = sshWorkspace(hops, "/srv/app", "/tmp/mount-b");
  assert.equal(projectWorkspacePath(binding, "/etc/hosts"), "/tmp/mount-b/etc/hosts");
  assert.equal(projectWorkspacePath(binding, "@/etc/hosts"), "/tmp/mount-b/etc/hosts");
  assert.equal(projectWorkspacePath(binding, "/../../etc/hosts"), "/tmp/mount-b/etc/hosts");
  assert.equal(projectWorkspacePath(binding, "src/index.ts"), "src/index.ts");
  assert.equal(projectWorkspacePath(binding, "@src/index.ts"), "@src/index.ts");
  assert.equal(
    projectWorkspacePath(binding, "../../../../etc/hosts"),
    "/tmp/mount-b/etc/hosts",
  );
  assert.throws(() => projectWorkspacePath(binding, "/bad\0path"), /NUL/);
});

test("leaves local bindings unchanged", () => {
  const binding = fileWorkspace("/work/project");
  assert.equal(workspaceUri(binding.target), "file:///work/project");
  assert.equal(projectWorkspacePath(binding, "/etc/hosts"), "/etc/hosts");
});

test("presents Pi's physical SSH cwd as the logical workspace", () => {
  const binding = sshWorkspace(hops, "/srv/app", "/tmp/mount-b");
  const prompt = presentWorkspaceCwd(
    `You are an agent.\nCurrent working directory: ${binding.piCwd}`,
    binding,
  );

  assert.match(prompt, /Current working directory: ssh:\/\/bob@10\.0\.0\.20:2222\/srv\/app/);
  assert.doesNotMatch(prompt, /\/tmp\/mount-b/);
});
