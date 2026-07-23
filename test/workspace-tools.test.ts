import assert from "node:assert/strict";
import test from "node:test";
import { applyWorkspaceToolPolicy, type WorkspaceBinding } from "../extensions/termia/workspace.ts";

const remoteBinding: WorkspaceBinding = {
  target: {
    scheme: "ssh",
    path: "/srv/app",
    hops: [{
      shellId: "shell-b",
      parentShellId: "shell-a",
      destination: "host-b",
      user: "bob",
      host: "host-b",
      port: 22,
      controlPath: "/tmp/termia-b/control",
    }],
  },
  piCwd: "/tmp/mount-b/srv/app",
  mountRoot: "/tmp/mount-b",
};

function toolEvent(toolName: string, input: Record<string, unknown>) {
  return { type: "tool_call" as const, toolCallId: "call-1", toolName, input };
}

test("projects every built-in file tool path into the leaf mount", () => {
  for (const toolName of ["read", "edit", "write", "grep", "find", "ls"] as const) {
    const event = toolEvent(toolName, { path: "/etc/hosts" });
    assert.deepEqual(applyWorkspaceToolPolicy(event, remoteBinding, true), { block: false });
    assert.equal(event.input.path, "/tmp/mount-b/etc/hosts");
  }
});

test("keeps relative paths on the remote session cwd and projects absolute @files", () => {
  const relative = toolEvent("read", { path: "src/index.ts" });
  const absoluteAt = toolEvent("read", { path: "@/etc/hosts" });
  applyWorkspaceToolPolicy(relative, remoteBinding, true);
  applyWorkspaceToolPolicy(absoluteAt, remoteBinding, true);
  assert.equal(relative.input.path, "src/index.ts");
  assert.equal(absoluteAt.input.path, "/tmp/mount-b/etc/hosts");
});

test("blocks all workspace tools when the leaf is unhealthy", () => {
  for (const toolName of ["read", "edit", "write", "grep", "find", "ls", "bash"] as const) {
    assert.deepEqual(
      applyWorkspaceToolPolicy(toolEvent(toolName, {}), remoteBinding, false),
      {
        block: true,
        reason: "Termia SSH workspace is disconnected; run /termia to return to the nearest live workspace",
      },
    );
  }
});

test("blocks remote tilde paths instead of expanding the local home directory", () => {
  assert.deepEqual(
    applyWorkspaceToolPolicy(toolEvent("read", { path: "~/.ssh/config" }), remoteBinding, true),
    {
      block: true,
      reason: "Termia cannot map ~ paths safely; use an absolute remote path",
    },
  );
});
