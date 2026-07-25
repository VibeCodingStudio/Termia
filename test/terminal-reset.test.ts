import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type {
  ActiveWorkspace,
  WorkspaceAccess,
  WorkspaceSummary,
} from "../extensions/termia/active-workspace.ts";
import {
  runTerminalReset,
  type ResettableWorkspaceRuntime,
} from "../extensions/termia/terminal-reset.ts";

type FakeRuntimeOptions = {
  stageError?: Error;
  commitError?: Error;
  disposeWorkspaceError?: Error;
};
type ReplacedContext = Parameters<
  NonNullable<NonNullable<Parameters<ExtensionCommandContext["switchSession"]>[1]>["withSession"]>
>[0];

function temporaryDirectory(t: test.TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "termia-reset-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function fakeAccess(cwd: string): WorkspaceAccess {
  const summary: WorkspaceSummary = {
    uri: new URL(`file://${cwd}`).href,
    generation: 1 as WorkspaceSummary["generation"],
    availability: { kind: "available" },
  };
  return {
    summary,
    executionDirectory: () => cwd,
    filePath: (path) => path,
    runDetached: async () => ({ exitCode: 0 }),
    present: (input) => input,
  };
}

function fakeRuntime(
  name: string,
  order: string[],
  cwd: string,
  options: FakeRuntimeOptions = {},
): ResettableWorkspaceRuntime {
  const access = fakeAccess(cwd);
  const workspace: ActiveWorkspace = {
    current: () => access,
    prepare: async () => ({ kind: "unchanged", active: access.summary }),
    failClosed: () => {},
    [Symbol.asyncDispose]: async () => {
      order.push(`dispose-workspace:${name}`);
      if (options.disposeWorkspaceError !== undefined) {
        throw options.disposeWorkspaceError;
      }
    },
  };
  return {
    workspace,
    terminal: {
      stage: async (stageCwd) => {
        order.push(`stage:${stageCwd}`);
        if (options.stageError !== undefined) throw options.stageError;
      },
      commitStaged: () => {
        order.push(`commit:${name}`);
        if (options.commitError !== undefined) throw options.commitError;
      },
      dispose: () => order.push(`stop:${name}`),
    },
  };
}

function commandContext(
  confirmed = true,
  notifications: Array<{ message: string; type: string | undefined }> = [],
): ExtensionCommandContext & ReplacedContext {
  return {
    cwd: "/old",
    ui: {
      confirm: async () => confirmed,
      notify: (message: string, type?: string) => notifications.push({ message, type }),
    },
    sendMessage: async () => {},
    sendUserMessage: async () => {},
  } as unknown as ExtensionCommandContext & ReplacedContext;
}

test("stages, hands off, swaps, then disposes the old runtime", async (t) => {
  const cwd = temporaryDirectory(t);
  const order: string[] = [];
  const oldRuntime = fakeRuntime("old", order, cwd);
  const staged = fakeRuntime("staged", order, cwd);
  const replacementCtx = commandContext();

  const result = await runTerminalReset({
    ctx: commandContext(),
    localCwd: cwd,
    current: oldRuntime,
    root: "/tmp/termia",
    createStaging: () => {
      order.push("create");
      return staged;
    },
    replace: (runtime) => {
      assert.equal(runtime, staged);
      order.push("swap");
    },
    handoff: async (_ctx, target, _root, options) => {
      order.push(`handoff:${target}`);
      await options?.withSession?.(replacementCtx);
      return { cancelled: false, switched: true };
    },
  });

  assert.deepEqual(result, { kind: "committed", context: replacementCtx });
  assert.deepEqual(order, [
    "create",
    `stage:${cwd}`,
    `handoff:${cwd}`,
    "swap",
    "stop:old",
    "commit:staged",
    "dispose-workspace:old",
  ]);
});

test("commits Terminal Reset when post-switch session archival fails", async (t) => {
  const cwd = temporaryDirectory(t);
  const order: string[] = [];
  const notifications: Array<{ message: string; type: string | undefined }> = [];
  const replacementCtx = commandContext(true, notifications);

  const result = await runTerminalReset({
    ctx: commandContext(),
    localCwd: cwd,
    current: fakeRuntime("old", order, cwd),
    root: "/tmp/termia",
    createStaging: () => fakeRuntime("staged", order, cwd),
    replace: () => order.push("swap"),
    handoff: async (_ctx, _target, _root, options) => {
      await options?.withSession?.(replacementCtx);
      return {
        cancelled: false,
        switched: true,
        cleanupError: new Error("source archive denied"),
      };
    },
  });

  assert.deepEqual(result, { kind: "committed", context: replacementCtx });
  assert.deepEqual(order, [
    `stage:${cwd}`,
    "swap",
    "stop:old",
    "commit:staged",
    "dispose-workspace:old",
  ]);
  assert.deepEqual(notifications, [{
    message: "Termia session cleanup failed after Terminal Reset: source archive denied",
    type: "warning",
  }]);
});

test("does nothing when Terminal Reset confirmation is declined", async (t) => {
  const cwd = temporaryDirectory(t);
  const order: string[] = [];

  const result = await runTerminalReset({
    ctx: commandContext(false),
    localCwd: cwd,
    current: fakeRuntime("old", order, cwd),
    root: "/tmp/termia",
    createStaging: () => {
      order.push("create");
      return fakeRuntime("staged", order, cwd);
    },
    replace: () => order.push("swap"),
    handoff: async () => {
      order.push("handoff");
      return { cancelled: false, switched: true };
    },
  });

  assert.deepEqual(result, { kind: "cancelled" });
  assert.deepEqual(order, []);
});

test("rejects a missing or non-directory local cwd before UI and mutation", async (t) => {
  const root = temporaryDirectory(t);
  const file = join(root, "not-a-directory");
  writeFileSync(file, "file");
  const order: string[] = [];
  const ctx = commandContext();
  let confirmations = 0;
  Reflect.set(ctx.ui, "confirm", async () => {
    confirmations += 1;
    return true;
  });
  const options = {
    ctx,
    current: fakeRuntime("old", order, root),
    root: "/tmp/termia",
    createStaging: () => {
      order.push("create");
      return fakeRuntime("staged", order, root);
    },
    replace: () => order.push("swap"),
  };

  await assert.rejects(
    runTerminalReset({ ...options, localCwd: join(root, "missing") }),
    /ENOENT|no such file/i,
  );
  await assert.rejects(
    runTerminalReset({ ...options, localCwd: file }),
    /Not a directory/,
  );
  assert.equal(confirmations, 0);
  assert.deepEqual(order, []);
});

test("cleans a staging failure without touching the old runtime", async (t) => {
  const cwd = temporaryDirectory(t);
  const order: string[] = [];
  const error = new Error("stage failed");

  await assert.rejects(runTerminalReset({
    ctx: commandContext(),
    localCwd: cwd,
    current: fakeRuntime("old", order, cwd),
    root: "/tmp/termia",
    createStaging: () => fakeRuntime("staged", order, cwd, { stageError: error }),
    replace: () => order.push("swap"),
  }), error);

  assert.deepEqual(order, [
    `stage:${cwd}`,
    "stop:staged",
    "dispose-workspace:staged",
  ]);
});

test("cleans the staged runtime and retains the old runtime when handoff is cancelled", async (t) => {
  const cwd = temporaryDirectory(t);
  const order: string[] = [];

  const result = await runTerminalReset({
    ctx: commandContext(),
    localCwd: cwd,
    current: fakeRuntime("old", order, cwd),
    root: "/tmp/termia",
    createStaging: () => fakeRuntime("staged", order, cwd),
    replace: () => order.push("swap"),
    handoff: async () => {
      order.push("handoff");
      return { cancelled: true, switched: false };
    },
  });

  assert.deepEqual(result, { kind: "cancelled" });
  assert.deepEqual(order, [
    `stage:${cwd}`,
    "handoff",
    "stop:staged",
    "dispose-workspace:staged",
  ]);
});

test("rethrows a handoff error after cleaning only the staged runtime", async (t) => {
  const cwd = temporaryDirectory(t);
  const order: string[] = [];
  const error = new Error("handoff failed");

  await assert.rejects(runTerminalReset({
    ctx: commandContext(),
    localCwd: cwd,
    current: fakeRuntime("old", order, cwd),
    root: "/tmp/termia",
    createStaging: () => fakeRuntime("staged", order, cwd),
    replace: () => order.push("swap"),
    handoff: async () => {
      order.push("handoff");
      throw error;
    },
  }), error);

  assert.deepEqual(order, [
    `stage:${cwd}`,
    "handoff",
    "stop:staged",
    "dispose-workspace:staged",
  ]);
});

test("cleans the staged runtime when replacement rejects before the swap", async (t) => {
  const cwd = temporaryDirectory(t);
  const order: string[] = [];
  const error = new Error("swap failed");

  await assert.rejects(runTerminalReset({
    ctx: commandContext(),
    localCwd: cwd,
    current: fakeRuntime("old", order, cwd),
    root: "/tmp/termia",
    createStaging: () => fakeRuntime("staged", order, cwd),
    replace: () => {
      order.push("swap-attempt");
      throw error;
    },
    handoff: async () => ({ cancelled: false, switched: true }),
  }), error);

  assert.deepEqual(order, [
    `stage:${cwd}`,
    "swap-attempt",
    "stop:staged",
    "dispose-workspace:staged",
  ]);
});

test("keeps the new runtime committed when old workspace cleanup fails", async (t) => {
  const cwd = temporaryDirectory(t);
  const order: string[] = [];
  const notifications: Array<{ message: string; type: string | undefined }> = [];
  const context = commandContext(true, notifications);

  const result = await runTerminalReset({
    ctx: context,
    localCwd: cwd,
    current: fakeRuntime("old", order, cwd, {
      disposeWorkspaceError: new Error("old cleanup failed"),
    }),
    root: "/tmp/termia",
    createStaging: () => fakeRuntime("staged", order, cwd),
    replace: () => order.push("swap"),
    handoff: async (_ctx, _target, _root, options) => {
      await options?.withSession?.(context);
      return { cancelled: false, switched: true };
    },
  });

  assert.deepEqual(result, { kind: "committed", context });
  assert.deepEqual(order, [
    `stage:${cwd}`,
    "swap",
    "stop:old",
    "commit:staged",
    "dispose-workspace:old",
  ]);
  assert.deepEqual(notifications, [{
    message: "Termia terminal reset cleanup failed: old cleanup failed",
    type: "error",
  }]);
});

test("does not roll back the swap when staged history commit fails", async (t) => {
  const cwd = temporaryDirectory(t);
  const order: string[] = [];
  const error = new Error("history commit failed");

  await assert.rejects(runTerminalReset({
    ctx: commandContext(),
    localCwd: cwd,
    current: fakeRuntime("old", order, cwd),
    root: "/tmp/termia",
    createStaging: () => fakeRuntime("staged", order, cwd, { commitError: error }),
    replace: () => order.push("swap"),
    handoff: async () => ({ cancelled: false, switched: true }),
  }), error);

  assert.deepEqual(order, [
    `stage:${cwd}`,
    "swap",
    "stop:old",
    "commit:staged",
    "dispose-workspace:old",
  ]);
});
