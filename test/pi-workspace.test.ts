import assert from "node:assert/strict";
import test from "node:test";
import type {
  BashOperations,
  ExtensionAPI,
  ExtensionCommandContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
  ActiveWorkspace,
  WorkspaceAccess,
  WorkspaceActivation,
  WorkspaceSummary,
} from "../extensions/termia/active-workspace.ts";
import { installPiWorkspaceAdapter } from "../extensions/termia/pi-workspace.ts";

function summary(uri: string): WorkspaceSummary {
  return {
    uri,
    generation: 1 as WorkspaceSummary["generation"],
    availability: { kind: "available" },
  };
}

function fakeAccess(uri = "file:///work/project"): WorkspaceAccess {
  const current = summary(uri);
  return {
    summary: current,
    executionDirectory: () => "/physical/work/project",
    filePath: (path) => path,
    runDetached: async () => ({ exitCode: 0 }),
    present: (input) => input,
  };
}

function fakeWorkspace(
  access: WorkspaceAccess,
  activation: WorkspaceActivation,
): ActiveWorkspace {
  return {
    current: () => access,
    prepare: async () => activation,
    [Symbol.asyncDispose]: async () => {},
  };
}

type RecordedHandler = (event: unknown, ctx: unknown) => unknown;

function fakePi(): {
  api: ExtensionAPI;
  tools: ToolDefinition[];
  handlers: Map<string, RecordedHandler>;
} {
  const tools: ToolDefinition[] = [];
  const handlers = new Map<string, RecordedHandler>();
  const api = {
    on: (event: string, handler: RecordedHandler) => handlers.set(event, handler),
    registerTool: (tool: ToolDefinition) => tools.push(tool),
  } as unknown as ExtensionAPI;
  return { api, tools, handlers };
}

function fakeBash(): BashOperations {
  return { exec: async () => ({ exitCode: 0 }) };
}

type ReplacedContext = Parameters<
  NonNullable<NonNullable<Parameters<ExtensionCommandContext["switchSession"]>[1]>["withSession"]>
>[0];

function fakeCommandContext(
  titles: string[] = [],
  notifications: Array<{ message: string; type: string | undefined }> = [],
): ReplacedContext {
  return {
    cwd: "/physical/work/project",
    ui: {
      setTitle: (title: string) => titles.push(title),
      notify: (message: string, type?: string) => notifications.push({ message, type }),
    },
    sendMessage: async () => {},
    sendUserMessage: async () => {},
  } as unknown as ReplacedContext;
}

test("commits a prepared workspace only after Pi handoff succeeds", async () => {
  const order: string[] = [];
  const active = summary("file:///work/project");
  const pending = {
    uri: "ssh://klein@server/srv/app",
    generation: 2 as WorkspaceSummary["generation"],
    active,
    readiness: "ready" as const,
  };
  const activation: WorkspaceActivation = {
    kind: "ready",
    pending,
    handoffCwd: "/physical/srv/app",
    commit: () => {
      order.push("commit");
      return { ...pending, availability: { kind: "available" } };
    },
    defer: () => ({ ...pending, readiness: "deferred" }),
  };
  const pi = fakePi();
  const adapter = installPiWorkspaceAdapter({
    pi: pi.api,
    workspace: () => fakeWorkspace(fakeAccess(), activation),
    enabled: () => true,
    localBash: fakeBash(),
    root: "/tmp/termia",
    handoff: async (_ctx, cwd, _root, options) => {
      order.push(`handoff:${cwd}`);
      await options?.withSession?.(fakeCommandContext());
      order.push("handoff-complete");
      return { cancelled: false, switched: true };
    },
  });

  assert.equal(await adapter.activate(fakeCommandContext(), "remote"), "committed");
  assert.deepEqual(order, ["handoff:/physical/srv/app", "handoff-complete", "commit"]);
});

test("routes Pi file tools and Bash through one current WorkspaceAccess", async () => {
  const calls: string[] = [];
  const access: WorkspaceAccess = {
    summary: summary("ssh://klein@server/srv/app"),
    executionDirectory: () => "/physical/srv/app",
    filePath: (path) => {
      calls.push(`file:${path}`);
      return `/mapped/${path}`;
    },
    runDetached: async ({ command, cwd, options }) => {
      calls.push(`bash:${command}:${cwd}`);
      options.onData(Buffer.from("ok"));
      return { exitCode: 0 };
    },
    present: (input) => input,
  };
  const activation: WorkspaceActivation = { kind: "unchanged", active: access.summary };
  const pi = fakePi();
  installPiWorkspaceAdapter({
    pi: pi.api,
    workspace: () => fakeWorkspace(access, activation),
    enabled: () => true,
    localBash: fakeBash(),
    root: "/tmp/termia",
  });
  const toolCall = pi.handlers.get("tool_call");
  assert.ok(toolCall);
  const readEvent = {
    type: "tool_call",
    toolCallId: "read-1",
    toolName: "read",
    input: { path: "src/index.ts" },
  };

  assert.equal(await toolCall(readEvent, fakeCommandContext()), undefined);
  assert.equal(readEvent.input.path, "/mapped/src/index.ts");
  const bash = pi.tools.find((tool) => tool.name === "bash");
  assert.ok(bash);
  await bash.execute(
    "bash-1",
    { command: "pwd" },
    undefined,
    undefined,
    fakeCommandContext(),
  );

  assert.deepEqual(calls, ["file:src/index.ts", "bash:pwd:/physical/srv/app"]);
});

test("presents the Active Workspace through before_agent_start", async () => {
  const access: WorkspaceAccess = {
    ...fakeAccess("ssh://klein@server/srv/app"),
    present: (input) => ({
      ...input,
      systemPrompt: `${input.systemPrompt}\nlogical-active-workspace`,
    }),
  };
  const pi = fakePi();
  installPiWorkspaceAdapter({
    pi: pi.api,
    workspace: () => fakeWorkspace(
      access,
      { kind: "unchanged", active: access.summary },
    ),
    enabled: () => true,
    localBash: fakeBash(),
    root: "/tmp/termia",
  });
  const beforeAgentStart = pi.handlers.get("before_agent_start");
  assert.ok(beforeAgentStart);

  const result = await beforeAgentStart({
    type: "before_agent_start",
    prompt: "hello",
    systemPrompt: "base prompt",
    systemPromptOptions: { skills: [{ filePath: "/remote/SKILL.md" }] },
  }, fakeCommandContext()) as { systemPrompt?: string } | undefined;

  assert.equal(result?.systemPrompt, "base prompt\nlogical-active-workspace");
});

test("defers a cancelled handoff without committing Active Workspace", async () => {
  let commits = 0;
  let deferredReason: string | undefined;
  const active = summary("file:///work/project");
  const pending = {
    uri: "ssh://klein@server/srv/app",
    generation: 2 as WorkspaceSummary["generation"],
    active,
    readiness: "ready" as const,
  };
  const activation: WorkspaceActivation = {
    kind: "ready",
    pending,
    handoffCwd: "/physical/srv/app",
    commit: () => {
      commits += 1;
      return summary(pending.uri);
    },
    defer: (reason) => {
      deferredReason = reason;
      return { ...pending, readiness: "deferred", reason };
    },
  };
  const notifications: Array<{ message: string; type: string | undefined }> = [];
  const adapter = installPiWorkspaceAdapter({
    pi: fakePi().api,
    workspace: () => fakeWorkspace(fakeAccess(), activation),
    enabled: () => true,
    localBash: fakeBash(),
    root: "/tmp/termia",
    handoff: async () => ({ cancelled: true, switched: false }),
  });

  assert.equal(
    await adapter.activate(fakeCommandContext([], notifications), "remote"),
    "cancelled",
  );
  assert.equal(commits, 0);
  assert.equal(deferredReason, "Pi session handoff was cancelled");
  assert.deepEqual(notifications, [{
    message: "Termia workspace handoff was cancelled; previous Active Workspace retained",
    type: "warning",
  }]);
});

test("defers when a handoff callback throws before commit", async () => {
  let commits = 0;
  let deferredReason: string | undefined;
  const active = summary("file:///work/project");
  const pending = {
    uri: "ssh://klein@server/srv/app",
    generation: 2 as WorkspaceSummary["generation"],
    active,
    readiness: "ready" as const,
  };
  const activation: WorkspaceActivation = {
    kind: "ready",
    pending,
    handoffCwd: "/physical/srv/app",
    commit: () => {
      commits += 1;
      return summary(pending.uri);
    },
    defer: (reason) => {
      deferredReason = reason;
      return { ...pending, readiness: "deferred", reason };
    },
  };
  const adapter = installPiWorkspaceAdapter({
    pi: fakePi().api,
    workspace: () => fakeWorkspace(fakeAccess(), activation),
    enabled: () => true,
    localBash: fakeBash(),
    root: "/tmp/termia",
    handoff: async (_ctx, _cwd, _root, options) => {
      await options?.withSession?.(fakeCommandContext());
      return { cancelled: false, switched: true };
    },
  });

  await assert.rejects(
    adapter.activate(fakeCommandContext(), "remote", {
      withSession: async () => {
        throw new Error("replacement initialization failed");
      },
    }),
    /replacement initialization failed/,
  );
  assert.equal(commits, 0);
  assert.equal(deferredReason, "replacement initialization failed");
});

test("reports a blocked Pending Workspace without changing the title", async () => {
  const active = summary("file:///work/project");
  const activation: WorkspaceActivation = {
    kind: "pending",
    pending: {
      uri: "ssh://klein@server/srv/app",
      generation: 2 as WorkspaceSummary["generation"],
      active,
      readiness: "blocked",
      reason: "sshfs mount denied",
    },
  };
  const titles: string[] = [];
  const notifications: Array<{ message: string; type: string | undefined }> = [];
  const adapter = installPiWorkspaceAdapter({
    pi: fakePi().api,
    workspace: () => fakeWorkspace(fakeAccess(), activation),
    enabled: () => true,
    localBash: fakeBash(),
    root: "/tmp/termia",
  });

  assert.equal(
    await adapter.activate(fakeCommandContext(titles, notifications), "remote"),
    "pending",
  );
  assert.deepEqual(titles, []);
  assert.deepEqual(notifications, [{
    message: [
      "Pending workspace: ssh://klein@server/srv/app",
      "Mount unavailable: sshfs mount denied",
      "Agent remains in file:///work/project",
    ].join("\n"),
    type: "warning",
  }]);
});

test("marks an unavailable Active Workspace in the title", () => {
  const titles: string[] = [];
  const access = fakeAccess("ssh://klein@server/srv/app");
  const unavailable: WorkspaceAccess = {
    ...access,
    summary: {
      ...access.summary,
      availability: { kind: "unavailable", reason: "sshfs disconnected" },
    },
  };
  const adapter = installPiWorkspaceAdapter({
    pi: fakePi().api,
    workspace: () => fakeWorkspace(
      unavailable,
      { kind: "unchanged", active: unavailable.summary },
    ),
    enabled: () => true,
    localBash: fakeBash(),
    root: "/tmp/termia",
  });

  adapter.show(fakeCommandContext(titles));
  assert.deepEqual(titles, ["Termia — ssh://klein@server/srv/app · unavailable"]);
});

test("keeps Pi hooks attached when Terminal Reset replaces the workspace core", () => {
  const first = fakeAccess("file:///work/first");
  const second = fakeAccess("file:///work/reset");
  let current = fakeWorkspace(
    first,
    { kind: "unchanged", active: first.summary },
  );
  const titles: string[] = [];
  const adapter = installPiWorkspaceAdapter({
    pi: fakePi().api,
    workspace: () => current,
    enabled: () => true,
    localBash: fakeBash(),
    root: "/tmp/termia",
  });

  adapter.show(fakeCommandContext(titles));
  current = fakeWorkspace(
    second,
    { kind: "unchanged", active: second.summary },
  );
  adapter.show(fakeCommandContext(titles));

  assert.deepEqual(titles, ["Termia — file:///work/first", "Termia — file:///work/reset"]);
});

test("blocks Pi Bash with an actionable unavailable Active Workspace reason", async () => {
  const access = fakeAccess("ssh://klein@server/srv/app");
  const unavailable: WorkspaceAccess = {
    ...access,
    summary: {
      ...access.summary,
      availability: { kind: "unavailable", reason: "sshfs disconnected" },
    },
  };
  const pi = fakePi();
  installPiWorkspaceAdapter({
    pi: pi.api,
    workspace: () => fakeWorkspace(
      unavailable,
      { kind: "unchanged", active: unavailable.summary },
    ),
    enabled: () => true,
    localBash: fakeBash(),
    root: "/tmp/termia",
  });
  const toolCall = pi.handlers.get("tool_call");
  assert.ok(toolCall);

  const result = await toolCall({
    type: "tool_call",
    toolCallId: "bash-1",
    toolName: "bash",
    input: { command: "pwd" },
  }, fakeCommandContext()) as { block?: boolean; reason?: string } | undefined;

  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /ssh:\/\/klein@server\/srv\/app/);
  assert.match(result?.reason ?? "", /sshfs disconnected/);
  assert.match(result?.reason ?? "", /\/termia reset/);
});

test("leaves Pi workspace hooks local while Termia is disabled", async () => {
  const calls: string[] = [];
  const localBash: BashOperations = {
    exec: async (command, cwd) => {
      calls.push(`local:${command}:${cwd}`);
      return { exitCode: 0 };
    },
  };
  const access: WorkspaceAccess = {
    ...fakeAccess(),
    filePath: (path) => {
      calls.push(`file:${path}`);
      return `/mapped/${path}`;
    },
  };
  const pi = fakePi();
  installPiWorkspaceAdapter({
    pi: pi.api,
    workspace: () => fakeWorkspace(
      access,
      { kind: "unchanged", active: access.summary },
    ),
    enabled: () => false,
    localBash,
    root: "/tmp/termia",
  });
  const readEvent = {
    type: "tool_call",
    toolCallId: "read-1",
    toolName: "read",
    input: { path: "src/index.ts" },
  };
  await pi.handlers.get("tool_call")?.(readEvent, fakeCommandContext());
  assert.equal(readEvent.input.path, "src/index.ts");
  const bash = pi.tools.find((tool) => tool.name === "bash");
  assert.ok(bash);
  await bash.execute(
    "bash-1",
    { command: "pwd" },
    undefined,
    undefined,
    { ...fakeCommandContext(), cwd: "/local/project" },
  );

  assert.deepEqual(calls, ["local:pwd:/physical/work/project"]);
  assert.equal(
    await pi.handlers.get("before_agent_start")?.({
      type: "before_agent_start",
      prompt: "hello",
      systemPrompt: "base",
      systemPromptOptions: {},
    }, fakeCommandContext()),
    undefined,
  );
});
