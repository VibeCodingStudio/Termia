import { fileURLToPath } from "node:url";
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
import {
  formatHistoryPaste,
  HistoryOverlay,
  HistoryOverlayModel,
} from "./history-overlay.ts";
import { createHistoryTool } from "./history-tool.ts";
import {
  termiaRoot,
  withTermiaHistoryTool,
} from "./mode.ts";
import { createModeBashOperations } from "./pty-bash.ts";
import {
  buildQuickMessages,
  parseQuickAskArguments,
  selectQuickHistory,
  type QuickAskInvocation,
} from "./quick-ask.ts";
import { runQuickPrint, type QuickPrintResult } from "./quick-runtime.ts";
import type { QuickAskRequest } from "./protocol.ts";
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
  type TerminalAttachExit,
} from "./terminal.ts";
import {
  applyWorkspaceToolPolicy,
  fileWorkspace,
  presentWorkspaceCwd,
  projectWorkspacePath,
  workspaceUri,
  type WorkspaceBinding,
} from "./workspace.ts";

type AttachedTurn = {
  output: string;
  exitCode: number;
  aborted: boolean;
  abort: () => void;
  finish: (result: QuickPrintResult) => void;
};

type TermiaRuntime = {
  api: ExtensionAPI | undefined;
  enabled: boolean;
  previousSessionFile: string | undefined;
  shortcutHintShown: boolean;
  editorDraft: string | undefined;
  history: HistoryStore;
  terminal: TerminalController;
  editorFactory: EditorFactory | undefined;
  attachedTurn: AttachedTurn | undefined;
  quickAskActive: boolean;
  piCwd: string;
  binding: WorkspaceBinding;
};

type ActiveTerminalContext = {
  ctx: ExtensionCommandContext;
  sendUserMessage: UserMessageSender;
};

type UserMessageSender = (message: string) => void | Promise<void>;

type BangExecutionOutcome =
  | { type: "success"; record: CommandRecord }
  | { type: "error"; message: string };

declare global {
  var __termiaPiRuntime: TermiaRuntime | undefined;
}

const ROOT = termiaRoot(getAgentDir());
const BANG_RESULT_TYPE = "termia.command";
const TERMIA_EXTENSION_PATH = fileURLToPath(import.meta.url);
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
      attachedTurn: undefined,
      quickAskActive: false,
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
    ? "\n\n[Output truncated. Use /termia-history for the full transcript.]"
    : "";
  return `Ran \`${data.command}\` in the persistent Termia shell\n${output}\n\nExit code: ${data.exitCode}\nWorking directory: ${data.cwd}${truncation}`;
}

async function enterTerminal(
  ctx: ExtensionCommandContext,
  state: TermiaRuntime,
  sendUserMessage: UserMessageSender,
): Promise<void> {
  if (state.terminal.running && !state.terminal.isWorkspaceHealthy(state.binding)) {
    const binding = state.terminal.nearestLiveWorkspace();
    const result = await handoffWorkspace(ctx, state, binding, {
      withSession: async (replacementCtx) => {
        await enterTerminal(
          replacementCtx,
          state,
          (message) => replacementCtx.sendUserMessage(message),
        );
      },
    });
    if (result.switched) return;
    if (result.cancelled) {
      ctx.ui.notify("Termia workspace recovery was cancelled", "warning");
      return;
    }
  }
  if (!state.terminal.running) state.terminal.start(ctx.cwd);
  try {
    await terminalLoop(state, {
      ctx,
      sendUserMessage,
    });
  } catch (error) {
    state.terminal.resumeUi();
    throw error;
  }
}

function finishAttachedTurn(state: TermiaRuntime, result: QuickPrintResult): void {
  const turn = state.attachedTurn;
  if (turn === undefined) return;
  state.attachedTurn = undefined;
  turn.finish(result);
}

function attachedTurn(
  state: TermiaRuntime,
  active: ActiveTerminalContext,
  message: string,
  signal: AbortSignal,
): Promise<QuickPrintResult> {
  if (state.attachedTurn !== undefined) throw new Error("A Termia attached quick ask is already running");
  if (signal.aborted) return Promise.resolve({ exitCode: 130, output: "Request aborted\n" });

  return new Promise((resolveTurn, rejectTurn) => {
    const abort = () => {
      const turn = state.attachedTurn;
      if (turn === undefined) return;
      turn.aborted = true;
      active.ctx.abort();
    };
    const finish = (result: QuickPrintResult) => {
      signal.removeEventListener("abort", abort);
      resolveTurn(result);
    };
    state.attachedTurn = {
      output: "",
      exitCode: 0,
      aborted: false,
      abort,
      finish,
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      void Promise.resolve(active.sendUserMessage(message)).catch((error: unknown) => {
        if (state.attachedTurn?.abort !== abort) return;
        state.attachedTurn = undefined;
        signal.removeEventListener("abort", abort);
        rejectTurn(error);
      });
    } catch (error) {
      state.attachedTurn = undefined;
      signal.removeEventListener("abort", abort);
      rejectTurn(error);
    }
  });
}

async function runAttachedQuickAsk(
  state: TermiaRuntime,
  active: ActiveTerminalContext,
  messages: readonly string[],
  signal: AbortSignal,
): Promise<QuickPrintResult> {
  let result: QuickPrintResult = { exitCode: 0, output: "" };
  for (const message of messages) {
    result = await attachedTurn(state, active, message, signal);
    if (result.exitCode !== 0) break;
  }
  return result;
}

function quickError(error: unknown): QuickPrintResult {
  return { exitCode: 1, output: `termia: ${errorMessage(error)}\n` };
}

async function answerQuickAsk(
  state: TermiaRuntime,
  active: ActiveTerminalContext,
  request: QuickAskRequest,
  invocation: QuickAskInvocation,
  messages: readonly string[],
): Promise<TerminalAttachExit> {
  const abortController = new AbortController();
  const attachment = state.terminal.enter(active.ctx, {
    refresh: false,
    onQuickAskAbort: () => abortController.abort(),
  });
  state.quickAskActive = true;
  let result: QuickPrintResult;
  try {
    if (invocation.attach) {
      result = await runAttachedQuickAsk(state, active, messages, abortController.signal);
      if (result.output.length > 0) process.stdout.write(result.output);
    } else {
      const binding = await state.terminal.readyWorkspace(request.shellId);
      const physicalRequest: QuickAskRequest = {
        ...request,
        cwd: binding.target.scheme === "ssh"
          ? projectWorkspacePath(binding, request.cwd)
          : request.cwd,
      };
      result = await runQuickPrint(
        physicalRequest,
        invocation,
        messages,
        state.history,
        state.terminal,
        {
          agentDir: getAgentDir(),
          projectTrusted: active.ctx.isProjectTrusted(),
          termiaExtensionPath: TERMIA_EXTENSION_PATH,
          binding,
        },
        abortController.signal,
      );
    }
  } catch (error) {
    result = quickError(error);
    process.stderr.write(result.output);
  } finally {
    state.quickAskActive = false;
  }
  state.terminal.completeQuickAsk(result.exitCode, result.output);
  return attachment;
}

async function terminalLoop(
  state: TermiaRuntime,
  active: ActiveTerminalContext,
  initialRequest?: QuickAskRequest,
): Promise<void> {
  let exit: TerminalAttachExit = initialRequest === undefined
    ? await state.terminal.enter(active.ctx)
    : { type: "quickAsk", request: initialRequest };

  while (exit.type === "quickAsk") {
    const request = exit.request;
    let invocation: QuickAskInvocation;
    let messages: string[];
    try {
      invocation = parseQuickAskArguments(request.argv);
      messages = buildQuickMessages(
        invocation.piArgs.messages,
        selectQuickHistory(state.history, invocation.history),
      );
    } catch (error) {
      const attachment = state.terminal.enter(active.ctx, { refresh: false });
      const result = quickError(error);
      process.stderr.write(result.output);
      state.terminal.completeQuickAsk(2, result.output);
      exit = await attachment;
      continue;
    }

    if (invocation.attach) {
      let binding: WorkspaceBinding;
      try {
        binding = await state.terminal.readyWorkspace(request.shellId);
      } catch (error) {
        const attachment = state.terminal.enter(active.ctx, { refresh: false });
        const result = quickError(error);
        process.stderr.write(result.output);
        state.terminal.completeQuickAsk(result.exitCode, result.output);
        exit = await attachment;
        continue;
      }
      if (binding.piCwd === active.ctx.cwd) {
        setBinding(state, binding);
      } else {
        const handoff = await handoffWorkspace(active.ctx, state, binding, {
          withSession: async (replacementCtx) => {
            await terminalLoop(
              state,
              {
                ctx: replacementCtx,
                sendUserMessage: (message) => replacementCtx.sendUserMessage(message),
              },
              request,
            );
          },
        });
        if (!handoff.cancelled) return;
        const attachment = state.terminal.enter(active.ctx, { refresh: false });
        const result = quickError(new Error("Termia cwd handoff was cancelled"));
        process.stderr.write(result.output);
        state.terminal.completeQuickAsk(result.exitCode, result.output);
        exit = await attachment;
        continue;
      }
    }

    exit = await answerQuickAsk(state, active, request, invocation, messages);
  }

  const binding = await state.terminal.readyWorkspace(exit.shellId);
  if (binding.piCwd === active.ctx.cwd) {
    setBinding(state, binding);
    showWorkspace(active.ctx, state);
    return;
  }
  const result = await handoffWorkspace(active.ctx, state, binding);
  if (result.cancelled) active.ctx.ui.notify("Termia cwd change was cancelled", "warning");
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
  sendUserMessage: UserMessageSender,
): Promise<void> {
  await ctx.waitForIdle();
  if (invocation.type === "terminal") {
    await enterTerminal(ctx, state, sendUserMessage);
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
                  ? "Termia enabled"
                  : "Termia enabled · Ctrl+] switches between Agent and PTY",
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
      ctx.ui.notify("Termia mode change was cancelled", "warning");
      return;
    }
    if (result.switched) {
      notifySwitched?.();
      return;
    }
    ctx.ui.notify("Termia mode has no session to return to", "error");
  } catch (error) {
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
    return { systemPrompt: presentWorkspaceCwd(event.systemPrompt, state.binding) };
  });

  pi.on("message_end", (event) => {
    const turn = state.attachedTurn;
    if (turn === undefined || event.message.role !== "assistant") return;
    if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
      turn.output = `${event.message.errorMessage ?? `Request ${event.message.stopReason}`}\n`;
      turn.exitCode = event.message.stopReason === "aborted" ? 130 : 1;
      return;
    }
    turn.output = event.message.content
      .filter((content) => content.type === "text")
      .map((content) => `${content.text}\n`)
      .join("");
    turn.exitCode = 0;
  });

  pi.on("agent_settled", () => {
    const turn = state.attachedTurn;
    if (turn === undefined) return;
    finishAttachedTurn(state, {
      exitCode: turn.aborted ? 130 : turn.exitCode,
      output: turn.output,
    });
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
    state.editorFactory = installBangEditor(
      ctx.ui,
      state.editorFactory,
      () => state.enabled,
      (draft) => {
        state.editorDraft = draft;
      },
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
      && !state.quickAskActive
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
              await runInvocation(pi, ctx, state, invocation, (message) => pi.sendUserMessage(message));
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
                    (message) => replacementCtx.sendUserMessage(message),
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
          await runInvocation(pi, ctx, state, invocation, (message) => pi.sendUserMessage(message));
        } catch (error) {
          ctx.ui.notify(errorMessage(error), "error");
        }
      } finally {
        if (invocation.type === "terminal") restoreEditorDraft(ctx, state);
      }
    },
  });

  pi.registerCommand("termia-history", {
    description: "Show persistent-shell command history",
    handler: async (_args, ctx) => {
      const state = runtime();
      if (!state.enabled) {
        ctx.ui.notify(TERMIA_DISABLED_NOTICE, "info");
        return;
      }
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        ctx.ui.notify("Termia history requires Pi TUI mode", "error");
        return;
      }
      if (state.history.listCommands(1).length === 0) {
        ctx.ui.notify("Termia command history is empty", "info");
        return;
      }
      const selected = await ctx.ui.custom<CommandRecord[] | undefined>(
        (_tui, theme, keybindings, done) =>
          new HistoryOverlay(
            new HistoryOverlayModel(
              state.history.listCommands(200),
              (command) => state.history.readOutput(command),
            ),
            theme,
            (data) => keybindings.matches(data, "app.tools.expand"),
            keybindings.getKeys("app.tools.expand").join("/"),
            done,
          ),
        {
          overlay: true,
          overlayOptions: { width: "80%", minWidth: 48, maxHeight: "80%" },
        },
      );
      if (selected !== undefined) ctx.ui.pasteToEditor(formatHistoryPaste(selected));
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
