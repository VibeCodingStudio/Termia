import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ActiveWorkspace } from "./active-workspace.ts";
import { handoffSession } from "./session.ts";
import type { TerminalController } from "./terminal.ts";

export type ResettableWorkspaceRuntime = {
  workspace: ActiveWorkspace;
  terminal: Pick<TerminalController, "stage" | "commitStaged" | "dispose">;
};

export type TerminalResetResult =
  | { kind: "cancelled" }
  | { kind: "committed"; context: ExtensionCommandContext };

type TerminalResetOptions<T extends ResettableWorkspaceRuntime> = {
  ctx: ExtensionCommandContext;
  localCwd: string;
  current: T;
  root: string;
  createStaging(cwd: string): Promise<T> | T;
  replace(staged: T): void;
  handoff?: typeof handoffSession;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function disposeStaged(runtime: ResettableWorkspaceRuntime): Promise<void> {
  let terminalError: unknown;
  try {
    runtime.terminal.dispose();
  } catch (error) {
    terminalError = error;
  }
  try {
    await runtime.workspace[Symbol.asyncDispose]();
  } catch (error) {
    if (terminalError === undefined) throw error;
  }
  if (terminalError !== undefined) throw terminalError;
}

export async function runTerminalReset<T extends ResettableWorkspaceRuntime>(
  options: TerminalResetOptions<T>,
): Promise<TerminalResetResult> {
  const validatedCwd = resolve(options.localCwd);
  if (!statSync(validatedCwd).isDirectory()) {
    throw new Error(`Not a directory: ${validatedCwd}`);
  }
  const confirmed = await options.ctx.ui.confirm(
    "Reset Termia terminal?",
    "This starts a fresh local terminal and discards the current terminal/SSH chain. Running jobs and unsaved shell state will be lost.",
  );
  if (!confirmed) return { kind: "cancelled" };

  let staged: T | undefined;
  let swapped = false;
  let replacementContext: ExtensionCommandContext | undefined;
  try {
    staged = await options.createStaging(validatedCwd);
    await staged.terminal.stage(validatedCwd);
    const targetCwd = staged.workspace.current().executionDirectory();
    const handoff = options.handoff ?? handoffSession;
    const result = await handoff(options.ctx, targetCwd, options.root, {
      withSession: async (nextContext) => {
        replacementContext = nextContext;
      },
    });
    if (result.cancelled) {
      await disposeStaged(staged);
      staged = undefined;
      return { kind: "cancelled" };
    }

    options.replace(staged);
    swapped = true;
    options.current.terminal.dispose();
    staged.terminal.commitStaged();
  } catch (error) {
    if (staged !== undefined && !swapped) {
      try {
        await disposeStaged(staged);
      } catch {}
    }
    if (swapped) {
      try {
        await options.current.workspace[Symbol.asyncDispose]();
      } catch (cleanupError) {
        (replacementContext ?? options.ctx).ui.notify(
          `Termia terminal reset cleanup failed: ${errorMessage(cleanupError)}`,
          "error",
        );
      }
    }
    throw error;
  }

  try {
    await options.current.workspace[Symbol.asyncDispose]();
  } catch (error) {
    (replacementContext ?? options.ctx).ui.notify(
      `Termia terminal reset cleanup failed: ${errorMessage(error)}`,
      "error",
    );
  }
  return { kind: "committed", context: replacementContext ?? options.ctx };
}
