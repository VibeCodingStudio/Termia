import type {
  BashOperations,
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  createLocalBashOperations,
  getAgentDir,
  isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import {
  installBangEditor,
  parseTermiaInvocation,
  type EditorFactory,
  type TermiaInvocation,
} from "./bang-editor.ts";
import {
  BangExecutionView,
  createBangResultData,
  isBangResultData,
  renderBangResult,
  type BangResultData,
} from "./bang-result.ts";
import { HistoryStore, type CommandRecord } from "./history.ts";
import { registerHistoryCommand } from "./history-overlay.ts";
import { createHistoryTool } from "./history-tool.ts";
import {
  termiaRoot,
  withTermiaHistoryTool,
} from "./mode.ts";
import { createModeBashOperations } from "./pty-bash.ts";
import {
  handoffSession,
  isManagedSession,
  releaseManagedSession,
  startManagedSession,
  type SessionTransitionOptions,
} from "./session.ts";
import {
  isTermiaPty,
  TerminalController,
} from "./terminal.ts";
import {
  applyWorkspaceToolPolicy,
  fileWorkspace,
  presentWorkspaceCwd,
  workspaceUri,
  type WorkspaceBinding,
} from "./workspace.ts";

type TermiaRuntime = {
  api: ExtensionAPI | undefined;
  enabled: boolean;
  previousSessionFile: string | undefined;
  shortcutHintShown: boolean;
  editorDraft: string | undefined;
  history: HistoryStore;
  terminal: TerminalController;
  editorFactory: EditorFactory | undefined;
  agentActive: boolean;
  piCwd: string;
  binding: WorkspaceBinding;
};

type BangExecutionOutcome =
  | { type: "success"; record: CommandRecord }
  | { type: "error"; message: string };

declare global {
  var __termiaPiRuntime: TermiaRuntime | undefined;
}

const ROOT = termiaRoot(getAgentDir());
const BANG_RESULT_TYPE = "termia.command";
const TERMIA_DISABLED_NOTICE = "Termia is disabled; run /termia to enable it";

function runtime(): TermiaRuntime {
  if (globalThis.__termiaPiRuntime === undefined) {
    const history = new HistoryStore(ROOT);
    const binding = fileWorkspace(process.cwd());
    globalThis.__termiaPiRuntime = {
      api: undefined,
      enabled: false,
      previousSessionFile: undefined,
      shortcutHintShown: false,
      editorDraft: undefined,
      history,
      terminal: new TerminalController(history),
      editorFactory: undefined,
      agentActive: false,
      piCwd: binding.piCwd,
      binding,
    };
  }
  return globalThis.__termiaPiRuntime;
}

function setBinding(state: TermiaRuntime, binding: WorkspaceBinding): void {
  state.binding = binding;
  state.piCwd = binding.piCwd;
}

async function handoffWorkspace(
  ctx: ExtensionCommandContext,
  state: TermiaRuntime,
  binding: WorkspaceBinding,
  options?: SessionTransitionOptions,
): Promise<{ cancelled: boolean; switched: boolean }> {
  const previous = state.binding;
  setBinding(state, binding);
  try {
    const result = await handoffSession(ctx, binding.piCwd, ROOT, options);
    if (result.cancelled) setBinding(state, previous);
    return result;
  } catch (error) {
    setBinding(state, previous);
    throw error;
  }
}

function showWorkspace(ctx: Pick<ExtensionCommandContext, "ui">, state: TermiaRuntime): void {
  if (!state.enabled) return;
  const uri = workspaceUri(state.binding.target);
  ctx.ui.setTitle(`Termia — ${uri}`);
}

function restoreEditorDraft(
  ctx: Pick<ExtensionCommandContext, "ui">,
  state: TermiaRuntime,
): void {
  const draft = state.editorDraft;
  if (draft === undefined) return;
  state.editorDraft = undefined;
  ctx.ui.setEditorText(draft);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bangContextText(data: BangResultData): string {
  const output = data.output.length === 0
    ? "(no output)"
    : `\`\`\`\n${data.output}\n\`\`\``;
  const truncation = data.truncated
    ? "\n\n[Output truncated. Use /history for the full transcript.]"
    : "";
  return `Ran \`${data.command}\` in the persistent Termia shell\n${output}\n\nExit code: ${data.exitCode}\nWorking directory: ${data.cwd}${truncation}`;
}

async function enterTerminal(
  ctx: ExtensionCommandContext,
  state: TermiaRuntime,
): Promise<void> {
  if (state.terminal.running && !state.terminal.isWorkspaceHealthy(state.binding)) {
    const binding = state.terminal.nearestLiveWorkspace();
    const result = await handoffWorkspace(ctx, state, binding, {
      withSession: async (replacementCtx) => {
        await enterTerminal(replacementCtx, state);
      },
    });
    if (result.switched) return;
    if (result.cancelled) {
      ctx.ui.notify("Termia workspace recovery was cancelled", "warning");
      return;
    }
  }
  if (!state.terminal.running) state.terminal.start(ctx.cwd);
  await terminalLoop(state, ctx);
}

async function terminalLoop(
  state: TermiaRuntime,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const exit = await state.terminal.enter(ctx);
  const binding = await state.terminal.readyWorkspace(exit.shellId);
  if (binding.piCwd === ctx.cwd) {
    setBinding(state, binding);
    showWorkspace(ctx, state);
    return;
  }
  const result = await handoffWorkspace(ctx, state, binding);
  if (result.cancelled) ctx.ui.notify("Termia cwd change was cancelled", "warning");
}

async function restoreTerminalCwd(
  ctx: ExtensionCommandContext,
  state: TermiaRuntime,
  cwd: string,
): Promise<void> {
  try {
    await state.terminal.restoreCwd(cwd);
  } catch (error) {
    state.terminal.dispose();
    ctx.ui.notify(`Termia cwd recovery failed: ${errorMessage(error)}`, "error");
    throw error;
  }
}

async function executeBang(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  state: TermiaRuntime,
  invocation: Extract<TermiaInvocation, { type: "bang" }>,
): Promise<void> {
  const originalCwd = ctx.cwd;
  const originalTerminalCwd = state.binding.target.scheme === "ssh"
    ? state.binding.target.path
    : originalCwd;
  if (!state.terminal.running) state.terminal.start(originalCwd);

  const outcome = await ctx.ui.custom<BangExecutionOutcome>(
    (tui, theme, _keybindings, done) => {
      const abortController = new AbortController();
      const view = new BangExecutionView(
        invocation.command,
        theme,
        () => abortController.abort(),
      );
      state.terminal.execute(invocation.command, {
        signal: abortController.signal,
        onOutput: (data) => {
          view.append(data);
          tui.requestRender();
        },
      }).then(
        (record) => done({ type: "success", record }),
        (error: unknown) => done({ type: "error", message: errorMessage(error) }),
      );
      return view;
    },
  );
  if (outcome.type === "error") throw new Error(outcome.message);

  const data = createBangResultData(
    invocation.command,
    outcome.record,
    state.terminal.cwd,
    state.history.readOutput(outcome.record),
  );
  if (invocation.excludeFromContext) {
    pi.appendEntry(BANG_RESULT_TYPE, data);
  } else {
    pi.sendMessage(
      {
        customType: BANG_RESULT_TYPE,
        content: bangContextText(data),
        display: true,
        details: data,
      },
      { triggerTurn: false },
    );
  }

  const sourceFile = ctx.sessionManager.getSessionFile();
  if (sourceFile === undefined) throw new Error("Termia cannot move an ephemeral Pi session");
  const binding = await state.terminal.readyWorkspace(outcome.record.shellId);
  const cwdChanged = binding.piCwd !== originalCwd;
  if (!cwdChanged && isManagedSession(sourceFile, ROOT)) return;
  try {
    const handoff = await handoffWorkspace(ctx, state, binding);
    if (!handoff.cancelled) return;
    if (cwdChanged) {
      await restoreTerminalCwd(ctx, state, originalTerminalCwd);
      ctx.ui.notify("Termia cwd change was cancelled; shell cwd restored", "warning");
    } else {
      ctx.ui.notify("Termia session handoff was cancelled", "warning");
    }
  } catch (error) {
    if (state.terminal.running && state.terminal.cwd !== originalTerminalCwd) {
      await restoreTerminalCwd(ctx, state, originalTerminalCwd);
    }
    throw error;
  }
}

async function runInvocation(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  state: TermiaRuntime,
  invocation: TermiaInvocation,
): Promise<void> {
  await ctx.waitForIdle();
  if (invocation.type === "terminal") {
    await enterTerminal(ctx, state);
  } else {
    await executeBang(pi, ctx, state, invocation);
  }
}

function synchronizeHistoryTool(api: ExtensionAPI, enabled: boolean): void {
  const active = api.getActiveTools();
  const next = withTermiaHistoryTool(active, enabled);
  if (next.length === active.length && next.every((tool, index) => tool === active[index])) return;
  api.setActiveTools(next);
}

function applyMode(state: TermiaRuntime, enabled: boolean): void {
  const api = state.api;
  if (api === undefined) throw new Error("Termia extension runtime is not active");
  synchronizeHistoryTool(api, enabled);
  state.enabled = enabled;
  if (!enabled) state.terminal.dispose();
}

async function toggleTermiaMode(
  ctx: ExtensionCommandContext,
  state: TermiaRuntime,
): Promise<void> {
  const currentSessionFile = ctx.sessionManager.getSessionFile();
  if (currentSessionFile === undefined) {
    ctx.ui.notify("Termia mode requires a persisted Pi session", "error");
    return;
  }

  const enabling = !state.enabled;
  const previousEnabled = state.enabled;
  state.enabled = enabling;
  let notifySwitched: (() => void) | undefined;
  try {
    const result = enabling
      ? await startManagedSession(ctx, ROOT, {
          withSession: async (replacementCtx) => {
            state.previousSessionFile = currentSessionFile;
            applyMode(state, true);
            showWorkspace(replacementCtx, state);
            notifySwitched = () => {
              replacementCtx.ui.notify(
                state.shortcutHintShown
                  ? "Termia enabled · /history opens command history"
                  : "Termia enabled · /history opens command history · Ctrl+] switches between Agent and PTY",
                "info",
              );
              state.shortcutHintShown = true;
            };
          },
        })
      : state.previousSessionFile === undefined
        ? { cancelled: false, switched: false }
        : await releaseManagedSession(ctx, state.previousSessionFile, ROOT, {
            withSession: async (replacementCtx) => {
              applyMode(state, false);
              state.previousSessionFile = undefined;
              setBinding(state, fileWorkspace(replacementCtx.cwd));
              notifySwitched = () => replacementCtx.ui.notify("Termia disabled", "info");
            },
          });

    if (result.cancelled) {
      state.enabled = previousEnabled;
      ctx.ui.notify("Termia mode change was cancelled", "warning");
      return;
    }
    if (result.switched) {
      notifySwitched?.();
      return;
    }
    state.enabled = previousEnabled;
    ctx.ui.notify("Termia mode has no session to return to", "error");
  } catch (error) {
    state.enabled = previousEnabled;
    ctx.ui.notify(`Termia mode change failed: ${errorMessage(error)}`, "error");
  }
}

export default function termia(pi: ExtensionAPI): void {
  const state = runtime();
  state.api = pi;
  pi.registerTool(createHistoryTool(state.history));
  const bashOperations: BashOperations = createModeBashOperations(
    () => state.enabled,
    createLocalBashOperations(),
    state.terminal,
  );
  pi.registerTool(createBashToolDefinition(state.piCwd, {
    operations: bashOperations,
    spawnHook: (context) => ({ ...context, cwd: state.piCwd }),
  }));

  pi.on("tool_call", (event) => {
    if (!state.enabled) return;
    const workspaceTool = isToolCallEventType("bash", event)
      || isToolCallEventType("read", event)
      || isToolCallEventType("edit", event)
      || isToolCallEventType("write", event)
      || isToolCallEventType("grep", event)
      || isToolCallEventType("find", event)
      || isToolCallEventType("ls", event);
    if (!workspaceTool) return;
    return applyWorkspaceToolPolicy(
      { toolName: event.toolName, input: event.input as Record<string, unknown> },
      state.binding,
      state.terminal.isWorkspaceHealthy(state.binding),
    );
  });

  pi.on("before_agent_start", (event) => {
    if (!state.enabled || state.binding.target.scheme !== "ssh") return;
    return {
      systemPrompt: presentWorkspaceCwd(
        event.systemPrompt,
        state.binding,
        event.systemPromptOptions.skills,
      ),
    };
  });

  pi.on("agent_start", () => {
    state.agentActive = true;
  });

  pi.on("agent_settled", () => {
    state.agentActive = false;
  });

  pi.registerMessageRenderer<BangResultData>(
    BANG_RESULT_TYPE,
    (message, _options, theme) =>
      isBangResultData(message.details)
        ? renderBangResult(message.details, theme)
        : undefined,
  );
  pi.registerEntryRenderer<BangResultData>(
    BANG_RESULT_TYPE,
    (entry, _options, theme) =>
      isBangResultData(entry.data)
        ? renderBangResult(entry.data, theme)
        : undefined,
  );

  pi.on("session_start", async (_event, ctx) => {
    if (isTermiaPty()) return;
    const state = runtime();
    registerHistoryCommand(pi, state.enabled, state.history);
    state.editorFactory = installBangEditor(
      ctx.ui,
      state.editorFactory,
      () => state.enabled,
      (draft) => {
        state.editorDraft = draft;
      },
      () => !state.agentActive,
    );
    restoreEditorDraft(ctx, state);
    if (!state.enabled) {
      setBinding(state, fileWorkspace(ctx.cwd));
      showWorkspace(ctx, state);
      state.terminal.dispose();
      try {
        synchronizeHistoryTool(pi, false);
      } catch (error) {
        ctx.ui.notify(`Termia tool policy failed: ${errorMessage(error)}`, "error");
      }
      return;
    }
    if (state.binding.piCwd !== ctx.cwd) {
      if (state.binding.target.scheme === "ssh") state.terminal.dispose();
      setBinding(state, fileWorkspace(ctx.cwd));
    }
    showWorkspace(ctx, state);
    if (
      state.terminal.running
      && state.binding.target.scheme === "file"
      && state.terminal.cwd !== ctx.cwd
    ) {
      try {
        await state.terminal.restoreCwd(ctx.cwd);
      } catch {
        state.terminal.dispose();
      }
    }
  });

  pi.registerCommand("termia", {
    description: "Toggle Termia mode",
    handler: async (args, ctx) => {
      const state = runtime();
      if (args.trim().length === 0) {
        await toggleTermiaMode(ctx, state);
        return;
      }
      if (!state.enabled) {
        ctx.ui.notify(TERMIA_DISABLED_NOTICE, "info");
        return;
      }
      if (isTermiaPty()) {
        ctx.ui.notify("Already inside a Termia PTY; nested Termia is disabled", "warning");
        return;
      }
      let invocation: TermiaInvocation;
      try {
        invocation = parseTermiaInvocation(args);
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
        return;
      }
      try {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          ctx.ui.notify("Termia requires Pi TUI mode", "error");
          return;
        }
        const sourceFile = ctx.sessionManager.getSessionFile();
        if (sourceFile === undefined) {
          ctx.ui.notify("Termia requires a persisted Pi session", "error");
          return;
        }

        if (!isManagedSession(sourceFile, ROOT)) {
          if (invocation.type === "bang") {
            try {
              await runInvocation(pi, ctx, state, invocation);
            } catch (error) {
              ctx.ui.notify(errorMessage(error), "error");
            }
            return;
          }
          try {
            const result = await handoffSession(ctx, ctx.cwd, ROOT, {
              withSession: async (replacementCtx) => {
                try {
                  await runInvocation(
                    pi,
                    replacementCtx,
                    state,
                    invocation,
                  );
                } catch (error) {
                  replacementCtx.ui.notify(errorMessage(error), "error");
                }
              },
            });
            if (result.cancelled) {
              ctx.ui.notify("Termia session handoff was cancelled", "warning");
            }
          } catch (error) {
            ctx.ui.notify(errorMessage(error), "error");
          }
          return;
        }

        try {
          await runInvocation(pi, ctx, state, invocation);
        } catch (error) {
          ctx.ui.notify(errorMessage(error), "error");
        }
      } finally {
        if (invocation.type === "terminal") restoreEditorDraft(ctx, state);
      }
    },
  });

  pi.on("session_shutdown", (event) => {
    if (event.reason !== "quit") return;
    const state = globalThis.__termiaPiRuntime;
    if (state === undefined) return;
    try {
      state.terminal.dispose();
    } finally {
      state.history.close();
      globalThis.__termiaPiRuntime = undefined;
    }
  });
}
