import type {
  BashOperations,
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  StaleActivationError,
  type ActiveWorkspace,
} from "./active-workspace.ts";
import {
  prepareSessionHandoff,
  type SessionTransitionOptions,
} from "./session.ts";

export type WorkspaceActivationResult =
  | "unchanged"
  | "committed"
  | "pending"
  | "cancelled";

export interface PiWorkspaceAdapter {
  activate(
    ctx: ExtensionCommandContext,
    shellId: string,
    options?: SessionTransitionOptions,
  ): Promise<WorkspaceActivationResult>;
  show(ctx: Pick<ExtensionCommandContext, "ui">): void;
}

type WorkspaceHandoffResult = {
  cancelled: boolean;
  switched: boolean;
  commit?(): void;
  rollback?(): Promise<ExtensionCommandContext | undefined>;
};

type WorkspaceHandoff = (
  ctx: ExtensionCommandContext,
  targetCwd: string,
  root: string,
  options?: SessionTransitionOptions,
) => Promise<WorkspaceHandoffResult>;

type PiWorkspaceOptions = {
  pi: ExtensionAPI;
  workspace(): ActiveWorkspace;
  enabled(): boolean;
  localBash: BashOperations;
  root: string;
  handoff?: WorkspaceHandoff;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const FILE_TOOLS = new Set(["read", "edit", "write", "grep", "find", "ls"]);

export function installPiWorkspaceAdapter(
  options: PiWorkspaceOptions,
): PiWorkspaceAdapter {
  const handoff = options.handoff ?? prepareSessionHandoff;
  const bashOperations: BashOperations = {
    exec: (command, cwd, execOptions) => options.enabled()
      ? options.workspace().current().runDetached({
          command,
          cwd,
          options: execOptions,
        })
      : options.localBash.exec(command, cwd, execOptions),
  };
  options.pi.registerTool(createBashToolDefinition(
    options.workspace().current().executionDirectory(),
    {
      operations: bashOperations,
      spawnHook: (context) => ({
        ...context,
        cwd: options.workspace().current().executionDirectory(),
      }),
    },
  ));
  options.pi.on("tool_call", (event) => {
    if (!options.enabled()) return;
    const access = options.workspace().current();
    if (FILE_TOOLS.has(event.toolName)) {
      const input = event.input as Record<string, unknown>;
      if (typeof input.path !== "string") return;
      try {
        input.path = access.filePath(input.path);
      } catch (error) {
        return { block: true, reason: errorMessage(error) };
      }
      return;
    }
    if (
      event.toolName === "bash"
      && access.summary.availability.kind === "unavailable"
    ) {
      return {
        block: true,
        reason: `Termia Active Workspace ${access.summary.uri} is unavailable: ${access.summary.availability.reason}; close the failed SSH hop in the terminal or run /termia reset`,
      };
    }
  });
  options.pi.on("before_agent_start", (event) => {
    if (!options.enabled()) return;
    const presented = options.workspace().current().present({
      systemPrompt: event.systemPrompt,
      skills: event.systemPromptOptions.skills ?? [],
    });
    return { systemPrompt: presented.systemPrompt };
  });

  const adapter: PiWorkspaceAdapter = {
    activate: async (ctx, shellId, transitionOptions) => {
      const prepared = await options.workspace().prepare(shellId);
      if (prepared.kind === "unchanged") {
        adapter.show(ctx);
        return "unchanged";
      }
      if (prepared.kind === "pending") {
        ctx.ui.notify(
          [
            `Pending workspace: ${prepared.pending.uri}`,
            `Mount unavailable: ${prepared.pending.reason ?? "unknown error"}`,
            `Agent remains in ${prepared.pending.active.uri}`,
          ].join("\n"),
          "warning",
        );
        return "pending";
      }

      let committed = false;
      let replacementCtx: ExtensionCommandContext | undefined;
      try {
        const result = await handoff(ctx, prepared.handoffCwd, options.root, {
          ...transitionOptions,
          withSession: async (nextCtx) => {
            replacementCtx = nextCtx;
            await transitionOptions?.withSession?.(nextCtx);
          },
        });
        if (result.cancelled) {
          prepared.defer("Pi session handoff was cancelled");
          ctx.ui.notify(
            "Termia workspace handoff was cancelled; previous Active Workspace retained",
            "warning",
          );
          return "cancelled";
        }
        try {
          prepared.commit();
          committed = true;
        } catch (commitError) {
          if (result.rollback === undefined) throw commitError;

          let restoredCtx: ExtensionCommandContext | undefined;
          try {
            restoredCtx = await result.rollback();
          } catch (rollbackError) {
            throw new AggregateError(
              [commitError, rollbackError],
              "Termia workspace activation failed and Pi session rollback was unsuccessful",
            );
          }
          try {
            prepared.defer(errorMessage(commitError));
          } catch (deferError) {
            if (!(deferError instanceof StaleActivationError)) throw deferError;
          }
          const rollbackCtx = restoredCtx ?? replacementCtx ?? ctx;
          rollbackCtx.ui.notify(
            `Termia workspace handoff rolled back: ${errorMessage(commitError)}; previous Active Workspace retained`,
            "warning",
          );
          adapter.show(rollbackCtx);
          return "cancelled";
        }
        result.commit?.();
        adapter.show(replacementCtx ?? ctx);
        return "committed";
      } catch (error) {
        if (!committed) {
          try {
            prepared.defer(errorMessage(error));
          } catch (deferError) {
            if (!(deferError instanceof StaleActivationError)) throw deferError;
          }
        }
        throw error;
      }
    },
    show: (ctx) => {
      if (!options.enabled()) return;
      const summary = options.workspace().current().summary;
      ctx.ui.setTitle(
        summary.availability.kind === "available"
          ? `Termia — ${summary.uri}`
          : `Termia — ${summary.uri} · unavailable`,
      );
    },
  };

  return adapter;
}
