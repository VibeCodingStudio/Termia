import assert from "node:assert/strict";
import test from "node:test";
import {
  applyWorkspaceToolPolicy,
  fileWorkspace,
  type WorkspaceBinding,
} from "../extensions/termia/workspace.ts";

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

test("keeps local absolute file-tool paths on the host", () => {
  for (const toolName of ["read", "edit", "write", "grep", "find", "ls"] as const) {
    const event = toolEvent(toolName, {
      path: "/home/klein/.pi/agent/skills/demo/SKILL.md",
    });
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

test("blocks all workspace tools when the leaf is unhealthy", () => {
  for (const toolName of ["read", "edit", "write", "grep", "find", "ls", "bash"] as const) {
    const input = toolName === "bash" ? {} : { path: "src/index.ts" };
    assert.deepEqual(
      applyWorkspaceToolPolicy(toolEvent(toolName, input), remoteBinding, false),
      {
        block: true,
        reason: "Termia SSH workspace is disconnected; run /termia to return to the nearest live workspace",
      },
    );
  }
});

test("allows local absolute paths when the SSH leaf is disconnected", () => {
  const local = toolEvent("read", { path: "/home/klein/file" });
  assert.deepEqual(applyWorkspaceToolPolicy(local, remoteBinding, false), { block: false });
  assert.equal(local.input.path, "/home/klein/file");
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

test("keeps Pi's native tilde handling outside SSH", () => {
  const local = toolEvent("read", { path: "~/.ssh/config" });
  assert.deepEqual(applyWorkspaceToolPolicy(local, fileWorkspace("/work/project"), true), {
    block: false,
  });
  assert.equal(local.input.path, "~/.ssh/config");
});
