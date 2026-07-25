import type {
  BashOperations,
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  createLocalBashOperations,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
  createActiveWorkspace,
  type ActiveWorkspace,
  type TerminalWorkspaceFeed,
} from "./active-workspace.ts";
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
import {
  installPiWorkspaceAdapter,
  type PiWorkspaceAdapter,
} from "./pi-workspace.ts";
import {
  handoffSession,
  isManagedSession,
  releaseManagedSession,
  startManagedSession,
} from "./session.ts";
import {
  isTermiaPty,
  TerminalController,
} from "./terminal.ts";
import { runTerminalReset } from "./terminal-reset.ts";

type WorkspaceRuntime = {
  workspace: ActiveWorkspace;
  terminalFeed: TerminalWorkspaceFeed;
  terminal: TerminalController;
};

type TermiaRuntime = {
  api: ExtensionAPI | undefined;
  enabled: boolean;
  previousSessionFile: string | undefined;
  shortcutHintShown: boolean;
  editorDraft: string | undefined;
  history: HistoryStore;
  localBash: BashOperations;
  workspaceRuntime: WorkspaceRuntime;
  piWorkspace: PiWorkspaceAdapter | undefined;
  editorFactory: EditorFactory | undefined;
  agentActive: boolean;
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

function createWorkspaceRuntime(
  cwd: string,
  history: HistoryStore,
  localBash: BashOperations,
): WorkspaceRuntime {
  const facets = createActiveWorkspace(cwd, {
    run: ({ command, cwd: commandCwd, options }) =>
      localBash.exec(command, commandCwd, options),
  });
  return {
    workspace: facets.workspace,
    terminalFeed: facets.terminal,
    terminal: new TerminalController(history, facets.terminal),
  };
}

async function replaceWorkspaceRuntime(
  state: TermiaRuntime,
  next: WorkspaceRuntime,
): Promise<void> {
  const previous = state.workspaceRuntime;
  state.workspaceRuntime = next;
  previous.terminal.dispose();
  await previous.workspace[Symbol.asyncDispose]();
}

function runtime(): TermiaRuntime {
  if (globalThis.__termiaPiRuntime === undefined) {
    const history = new HistoryStore(ROOT);
    const localBash = createLocalBashOperations();
    globalThis.__termiaPiRuntime = {
      api: undefined,
      enabled: false,
      previousSessionFile: undefined,
      shortcutHintShown: false,
      editorDraft: undefined,
      history,
      localBash,
      workspaceRuntime: createWorkspaceRuntime(process.cwd(), history, localBash),
      piWorkspace: undefined,
      editorFactory: undefined,
      agentActive: false,
    };
  }
  return globalThis.__termiaPiRuntime;
}

function piWorkspace(state: TermiaRuntime): PiWorkspaceAdapter {
  if (state.piWorkspace === undefined) {
    throw new Error("Termia Pi workspace adapter is not installed");
  }
  return state.piWorkspace;
}

function showWorkspace(ctx: Pick<ExtensionCommandContext, "ui">, state: TermiaRuntime): void {
  piWorkspace(state).show(ctx);
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
  const runtime = state.workspaceRuntime;
  if (!runtime.terminal.running) runtime.terminal.start(runtime.terminalFeed.localCwd());
  await terminalLoop(state, ctx);
}

async function terminalLoop(
  state: TermiaRuntime,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const exit = await state.workspaceRuntime.terminal.enter(ctx);
  await piWorkspace(state).activate(ctx, exit.shellId);
}

async function executeBang(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  state: TermiaRuntime,
  invocation: Extract<TermiaInvocation, { type: "bang" }>,
): Promise<void> {
  const terminal = state.workspaceRuntime.terminal;
  if (!terminal.running) terminal.start(state.workspaceRuntime.terminalFeed.localCwd());

  const outcome = await ctx.ui.custom<BangExecutionOutcome>(
    (tui, theme, _keybindings, done) => {
      const abortController = new AbortController();
      const view = new BangExecutionView(
        invocation.command,
        theme,
        () => abortController.abort(),
      );
      terminal.execute(invocation.command, {
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
    terminal.cwd,
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
  const activation = await piWorkspace(state).activate(ctx, outcome.record.shellId);
  if (activation !== "unchanged" || isManagedSession(sourceFile, ROOT)) return;

  const handoff = await handoffSession(
    ctx,
    state.workspaceRuntime.workspace.current().executionDirectory(),
    ROOT,
  );
  if (handoff.cancelled) {
    ctx.ui.notify("Termia session handoff was cancelled", "warning");
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
              await replaceWorkspaceRuntime(
                state,
                createWorkspaceRuntime(replacementCtx.cwd, state.history, state.localBash),
              );
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
  state.piWorkspace = installPiWorkspaceAdapter({
    pi,
    workspace: () => state.workspaceRuntime.workspace,
    enabled: () => state.enabled,
    localBash: state.localBash,
    root: ROOT,
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
      await replaceWorkspaceRuntime(
        state,
        createWorkspaceRuntime(ctx.cwd, state.history, state.localBash),
      );
      try {
        synchronizeHistoryTool(pi, false);
      } catch (error) {
        ctx.ui.notify(`Termia tool policy failed: ${errorMessage(error)}`, "error");
      }
      return;
    }
    showWorkspace(ctx, state);
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
      if (args.trim() === "reset") {
        try {
          const reset = await runTerminalReset({
            ctx,
            localCwd: state.workspaceRuntime.terminalFeed.localCwd(),
            current: state.workspaceRuntime,
            root: ROOT,
            createStaging: (cwd) =>
              createWorkspaceRuntime(cwd, state.history, state.localBash),
            replace: (staged) => {
              state.workspaceRuntime = staged;
            },
          });
          if (reset.kind === "committed") state.piWorkspace?.show(reset.context);
        } catch (error) {
          ctx.ui.notify(`Termia terminal reset failed: ${errorMessage(error)}`, "error");
        }
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
      state.workspaceRuntime.terminal.dispose();
      void state.workspaceRuntime.workspace[Symbol.asyncDispose]();
    } finally {
      state.history.close();
      globalThis.__termiaPiRuntime = undefined;
    }
  });
}
