import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import {
  SessionManager,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

type SwitchSessionOptions = NonNullable<Parameters<ExtensionCommandContext["switchSession"]>[1]>;
type WithSession = NonNullable<SwitchSessionOptions["withSession"]>;
type ReplacedSessionContext = Parameters<WithSession>[0];
type HandoffContext = Pick<ExtensionCommandContext, "cwd" | "waitForIdle" | "switchSession"> & {
  sessionManager: Pick<ExtensionCommandContext["sessionManager"], "getSessionFile">;
};
export type SessionTransitionOptions = {
  withSession?: WithSession;
};
export class SessionRollbackError extends AggregateError {}
export type PreparedSessionHandoff = {
  cancelled: boolean;
  switched: boolean;
  commit(): unknown | undefined;
  rollback(): Promise<{
    context?: ReplacedSessionContext;
    cleanupError?: unknown;
  }>;
};

function sessionDirectory(root: string): string {
  return resolve(root, "pi-sessions");
}

function isWithin(directory: string, file: string): boolean {
  const location = relative(directory, resolve(file));
  return location !== "" && location !== ".." && !location.startsWith(`..${sep}`) && !isAbsolute(location);
}

export function createManagedSession(targetCwd: string, root: string): string {
  if (!statSync(targetCwd).isDirectory()) throw new Error(`Not a directory: ${targetCwd}`);
  const directory = sessionDirectory(root);
  mkdirSync(directory, { recursive: true });
  const fresh = SessionManager.create(targetCwd, directory);
  const freshFile = fresh.getSessionFile();
  if (freshFile === undefined) throw new Error("Pi did not allocate a Termia session file");
  writeFileSync(freshFile, "", { flag: "wx" });
  const session = SessionManager.open(freshFile, directory, targetCwd);
  const file = session.getSessionFile();
  if (file === undefined) throw new Error("Pi did not persist the Termia session");
  return file;
}

export function forkManagedSession(sourceFile: string, targetCwd: string, root: string): string {
  if (!statSync(targetCwd).isDirectory()) throw new Error(`Not a directory: ${targetCwd}`);
  if (!existsSync(sourceFile) || statSync(sourceFile).size === 0) {
    return createManagedSession(targetCwd, root);
  }
  const fork = SessionManager.forkFrom(sourceFile, targetCwd, sessionDirectory(root));
  const file = fork.getSessionFile();
  if (file === undefined) throw new Error("Pi did not persist the Termia session fork");
  return file;
}

export function isManagedSession(file: string, root: string): boolean {
  return isWithin(sessionDirectory(root), file);
}

export function retireManagedSession(file: string, root: string): string | undefined {
  if (!isManagedSession(file, root) || !existsSync(file)) return undefined;
  return retireSessionFile(file, root);
}

function captureRetirementError(file: string, root: string): unknown | undefined {
  try {
    retireManagedSession(file, root);
    return undefined;
  } catch (error) {
    return error;
  }
}

function retireSessionFile(file: string, root: string): string {
  const retiredDirectory = resolve(root, "retired");
  mkdirSync(retiredDirectory, { recursive: true });
  const destination = resolve(retiredDirectory, `${Date.now()}-${basename(file)}`);
  renameSync(file, destination);
  return destination;
}

export async function handoffSession(
  ctx: HandoffContext,
  targetCwd: string,
  root: string,
  options?: SessionTransitionOptions,
): Promise<{ cancelled: boolean; switched: boolean }> {
  await ctx.waitForIdle();
  const sourceFile = ctx.sessionManager.getSessionFile();
  if (sourceFile === undefined) throw new Error("Termia cannot move an ephemeral Pi session");
  if (ctx.cwd === targetCwd && isManagedSession(sourceFile, root)) {
    return { cancelled: false, switched: false };
  }

  const replacementFile = forkManagedSession(sourceFile, targetCwd, root);
  const result = options?.withSession === undefined
    ? await ctx.switchSession(replacementFile)
    : await ctx.switchSession(replacementFile, { withSession: options.withSession });
  if (result.cancelled) {
    retireManagedSession(replacementFile, root);
    return { cancelled: true, switched: false };
  }

  retireManagedSession(sourceFile, root);
  return { cancelled: false, switched: true };
}

export async function prepareSessionHandoff(
  ctx: HandoffContext,
  targetCwd: string,
  root: string,
  options?: SessionTransitionOptions,
): Promise<PreparedSessionHandoff> {
  await ctx.waitForIdle();
  const sourceFile = ctx.sessionManager.getSessionFile();
  if (sourceFile === undefined) throw new Error("Termia cannot move an ephemeral Pi session");
  if (ctx.cwd === targetCwd && isManagedSession(sourceFile, root)) {
    let settled = false;
    return {
      cancelled: false,
      switched: false,
      commit: () => {
        if (settled) throw new Error("Termia session handoff is already settled");
        settled = true;
      },
      rollback: async () => {
        if (settled) throw new Error("Termia session handoff is already settled");
        settled = true;
        return {};
      },
    };
  }

  const replacementFile = forkManagedSession(sourceFile, targetCwd, root);
  let replacementContext: ReplacedSessionContext | undefined;
  const rollbackSwitch = async (): Promise<{
    context?: ReplacedSessionContext;
    cleanupError?: unknown;
  }> => {
    if (replacementContext === undefined) return {};
    let restoredContext: ReplacedSessionContext | undefined;
    const rollback = await replacementContext.switchSession(sourceFile, {
      withSession: async (nextContext) => {
        restoredContext = nextContext;
      },
    });
    if (rollback.cancelled) {
      throw new Error("Termia could not roll back the Pi session handoff");
    }
    const cleanupError = captureRetirementError(replacementFile, root);
    return {
      ...(restoredContext === undefined ? {} : { context: restoredContext }),
      ...(cleanupError === undefined ? {} : { cleanupError }),
    };
  };

  let result: { cancelled: boolean };
  try {
    result = await ctx.switchSession(replacementFile, {
      withSession: async (nextContext) => {
        replacementContext = nextContext;
        await options?.withSession?.(nextContext);
      },
    });
  } catch (error) {
    let cleanupError: unknown | undefined;
    try {
      if (replacementContext === undefined) {
        cleanupError = captureRetirementError(replacementFile, root);
      } else {
        const rollback = await rollbackSwitch();
        cleanupError = rollback.cleanupError;
      }
    } catch (rollbackError) {
      throw new SessionRollbackError(
        [error, rollbackError],
        "Termia session handoff failed and rollback was unsuccessful",
      );
    }
    if (cleanupError !== undefined) {
      throw new AggregateError(
        [error, cleanupError],
        "Termia session handoff failed, rollback succeeded, and replacement cleanup failed",
      );
    }
    throw error;
  }
  if (result.cancelled) {
    retireManagedSession(replacementFile, root);
    return {
      cancelled: true,
      switched: false,
      commit: () => {},
      rollback: async () => ({}),
    };
  }

  let settled = false;
  return {
    cancelled: false,
    switched: true,
    commit: () => {
      if (settled) throw new Error("Termia session handoff is already settled");
      settled = true;
      return captureRetirementError(sourceFile, root);
    },
    rollback: async () => {
      if (settled) throw new Error("Termia session handoff is already settled");
      const restored = await rollbackSwitch();
      settled = true;
      return restored;
    },
  };
}

export async function startManagedSession(
  ctx: HandoffContext,
  root: string,
  options?: SessionTransitionOptions,
): Promise<{ cancelled: boolean; switched: boolean }> {
  await ctx.waitForIdle();
  if (ctx.sessionManager.getSessionFile() === undefined) {
    throw new Error("Termia mode requires a persisted Pi session");
  }

  const replacementFile = createManagedSession(ctx.cwd, root);
  const result = options?.withSession === undefined
    ? await ctx.switchSession(replacementFile)
    : await ctx.switchSession(replacementFile, { withSession: options.withSession });
  if (result.cancelled) {
    retireManagedSession(replacementFile, root);
    return { cancelled: true, switched: false };
  }

  return { cancelled: false, switched: true };
}

export async function releaseManagedSession(
  ctx: HandoffContext,
  targetSessionFile: string,
  root: string,
  options?: SessionTransitionOptions,
): Promise<{ cancelled: boolean; switched: boolean }> {
  await ctx.waitForIdle();
  const sourceFile = ctx.sessionManager.getSessionFile();
  if (sourceFile === undefined) throw new Error("Termia cannot move an ephemeral Pi session");
  if (!isManagedSession(sourceFile, root)) {
    return { cancelled: false, switched: false };
  }

  const result = options?.withSession === undefined
    ? await ctx.switchSession(targetSessionFile)
    : await ctx.switchSession(targetSessionFile, { withSession: options.withSession });
  if (result.cancelled) {
    return { cancelled: true, switched: false };
  }

  return { cancelled: false, switched: true };
}
