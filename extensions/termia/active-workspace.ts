import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  IdentityOperations,
  MountOperations,
  WorkspaceContext,
} from "./ssh-workspace.ts";
import { buildRemoteBashCommand, SshChain } from "./ssh-workspace.ts";
import type { IdentityOpenEvent, SshOpenEvent } from "./protocol.ts";
import {
  fileWorkspace,
  presentWorkspaceCwd,
  projectWorkspacePath,
  workspaceUri,
  type WorkspaceBinding,
} from "./workspace.ts";

export type WorkspaceGeneration = number & {
  readonly __workspaceGeneration: unique symbol;
};

export type WorkspaceAvailability =
  | { kind: "available" }
  | { kind: "unavailable"; reason: string };

export type WorkspaceSummary = {
  uri: string;
  generation: WorkspaceGeneration;
  availability: WorkspaceAvailability;
};

export type PendingWorkspaceSummary = {
  uri: string;
  generation: WorkspaceGeneration;
  active: WorkspaceSummary;
  readiness: "ready" | "blocked" | "deferred";
  reason?: string;
};

export type DetachedCommand = {
  command: string;
  cwd: string;
  options: {
    onData(data: Buffer): void;
    signal?: AbortSignal;
    timeout?: number;
    env?: NodeJS.ProcessEnv;
  };
};

export type DetachedCommandResult = { exitCode: number | null };

export class StaleActivationError extends Error {}
export class StaleWorkspaceAccessError extends Error {}
export class WorkspacePathError extends Error {}
export class WorkspaceUnavailableError extends Error {}

export interface DetachedCommandOperations {
  run(input: DetachedCommand): Promise<DetachedCommandResult>;
}

export type AgentPresentation = {
  systemPrompt: string;
  skills: readonly { filePath: string }[];
};

export interface WorkspaceAccess {
  readonly summary: WorkspaceSummary;
  executionDirectory(): string;
  filePath(input: string): string;
  runDetached(input: DetachedCommand): Promise<DetachedCommandResult>;
  present(input: AgentPresentation): AgentPresentation;
}

export type WorkspaceActivation =
  | { kind: "unchanged"; active: WorkspaceSummary }
  | { kind: "pending"; pending: PendingWorkspaceSummary }
  | {
      kind: "ready";
      pending: PendingWorkspaceSummary;
      handoffCwd: string;
      commit(): WorkspaceSummary;
      defer(reason: string): PendingWorkspaceSummary;
    };

export interface ActiveWorkspace extends AsyncDisposable {
  current(): WorkspaceAccess;
  prepare(shellId: string): Promise<WorkspaceActivation>;
}

export interface TerminalWorkspaceFeed {
  resetRoot(cwd: string, shellId: string): void;
  openSsh(event: SshOpenEvent): void;
  openIdentity(event: IdentityOpenEvent, privateKey: string): void;
  updateCwd(shellId: string, cwd: string): void;
  close(shellId: string): Promise<void>;
  contextFor(shellId: string, cwd?: string): WorkspaceContext;
  localCwd(): string;
  terminalExited(): Promise<void>;
}

function asGeneration(value: number): WorkspaceGeneration {
  return value as WorkspaceGeneration;
}

class ActiveWorkspaceState {
  private readonly chain: SshChain;
  private readonly detached: DetachedCommandOperations;
  private active: WorkspaceBinding;
  private generation = 1;
  private topologyRevision = 1;
  private activationEpoch = 0;
  private availability: WorkspaceAvailability = { kind: "available" };
  private terminalCleanup: Promise<void> | undefined;
  private finalDisposal: Promise<void> | undefined;
  private rootShellId = "local";
  private localCwdValue: string;
  private disposed = false;

  constructor(
    cwd: string,
    detached: DetachedCommandOperations,
    mounts: MountOperations | undefined,
    identities: IdentityOperations | undefined,
  ) {
    this.detached = detached;
    this.active = fileWorkspace(cwd);
    this.localCwdValue = this.active.piCwd;
    this.chain = new SshChain(this.active, "local", mounts, identities);
  }

  current(): WorkspaceAccess {
    this.assertLive();
    this.refreshAvailability();
    const generation = asGeneration(this.generation);
    const binding = this.active;
    return {
      summary: this.summary(binding),
      executionDirectory: () => {
        this.assertCurrent(generation);
        return binding.piCwd;
      },
      filePath: (input) => {
        this.assertCurrent(generation);
        try {
          if (binding.target.scheme === "ssh" && /^~(?:\/|$)/.test(input)) {
            throw new WorkspacePathError(
              "Termia cannot map ~ paths safely; use an absolute remote path",
            );
          }
          if (
            binding.target.scheme === "ssh"
            && this.availability.kind === "unavailable"
            && this.traversesRemoteMount(binding, input)
          ) {
            throw new WorkspaceUnavailableError(this.unavailableMessage());
          }
          return projectWorkspacePath(binding, input);
        } catch (error) {
          if (
            error instanceof WorkspacePathError
            || error instanceof WorkspaceUnavailableError
          ) throw error;
          throw new WorkspacePathError(
            error instanceof Error ? error.message : String(error),
            { cause: error },
          );
        }
      },
      runDetached: async (input) => {
        this.assertCurrent(generation);
        if (resolve(input.cwd) !== resolve(binding.piCwd)) {
          throw new Error(
            `Termia command cwd is outside the Active Workspace: ${input.cwd}`,
          );
        }
        if (
          binding.target.scheme === "ssh"
          && this.availability.kind === "unavailable"
        ) {
          throw new WorkspaceUnavailableError(this.unavailableMessage());
        }
        if (binding.target.scheme === "file") {
          return this.detached.run(input);
        }
        return this.detached.run({
          ...input,
          command: buildRemoteBashCommand(
            binding.target.hops,
            binding.target.path,
            input.command,
          ),
        });
      },
      present: (input) => {
        this.assertCurrent(generation);
        return {
          ...input,
          systemPrompt: presentWorkspaceCwd(
            input.systemPrompt,
            binding,
            input.skills,
          ),
        };
      },
    };
  }

  async prepare(shellId: string): Promise<WorkspaceActivation> {
    this.assertLive();
    const ticketEpoch = ++this.activationEpoch;
    const preparedAt = this.topologyRevision;
    const active = this.current().summary;
    let binding: WorkspaceBinding;
    try {
      binding = await this.chain.readyBinding(shellId);
    } catch (error) {
      this.assertPreparationCurrent(ticketEpoch, preparedAt, active.uri);
      return {
        kind: "pending",
        pending: {
          uri: this.chain.contextFor(shellId).workspaceUri,
          generation: asGeneration(this.generation + 1),
          active,
          readiness: "blocked",
          reason: error instanceof Error ? error.message : String(error),
        },
      };
    }
    this.assertPreparationCurrent(ticketEpoch, preparedAt, active.uri);
    if (
      workspaceUri(binding.target) === active.uri
      && binding.piCwd === this.active.piCwd
    ) {
      return { kind: "unchanged", active };
    }
    const pending: PendingWorkspaceSummary = {
      uri: workspaceUri(binding.target),
      generation: asGeneration(this.generation + 1),
      active,
      readiness: "ready",
    };
    let consumed = false;
    const consume = (): void => {
      if (
        consumed
        || this.disposed
        || preparedAt !== this.topologyRevision
        || ticketEpoch !== this.activationEpoch
      ) {
        throw new StaleActivationError(
          `Termia rejected stale Active Workspace activation for ${pending.uri}`,
        );
      }
      consumed = true;
      this.activationEpoch += 1;
    };
    return {
      kind: "ready",
      pending,
      handoffCwd: binding.piCwd,
      commit: () => {
        consume();
        this.active = binding;
        this.availability = { kind: "available" };
        this.generation += 1;
        return this.summary(this.active);
      },
      defer: (reason) => {
        consume();
        return {
          ...pending,
          readiness: "deferred",
          reason,
        };
      },
    };
  }

  resetRoot(cwd: string, shellId: string): void {
    this.chain.resetRoot(fileWorkspace(cwd), shellId);
    this.rootShellId = shellId;
    this.localCwdValue = fileWorkspace(cwd).piCwd;
    this.terminalCleanup = undefined;
    this.topologyRevision += 1;
  }

  openSsh(event: SshOpenEvent): void {
    this.chain.open(event);
    this.topologyRevision += 1;
  }

  openIdentity(event: IdentityOpenEvent, privateKey: string): void {
    this.chain.openIdentity(event, privateKey);
    this.topologyRevision += 1;
  }

  updateCwd(shellId: string, cwd: string): void {
    this.chain.updateCwd(shellId, cwd);
    if (shellId === this.rootShellId) this.localCwdValue = fileWorkspace(cwd).piCwd;
    this.topologyRevision += 1;
  }

  async close(shellId: string): Promise<void> {
    this.topologyRevision += 1;
    await this.chain.close(shellId);
  }

  contextFor(shellId: string, cwd?: string): WorkspaceContext {
    return this.chain.contextFor(shellId, cwd);
  }

  localCwd(): string {
    return this.localCwdValue;
  }

  async terminalExited(): Promise<void> {
    if (this.disposed) {
      await this.finalDisposal;
      return;
    }
    this.topologyRevision += 1;
    this.terminalCleanup ??= this.chain.dispose();
    await this.terminalCleanup;
    this.refreshAvailability();
  }

  async dispose(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true;
      this.topologyRevision += 1;
      this.activationEpoch += 1;
      this.generation += 1;
    }
    this.finalDisposal ??= this.terminalCleanup ?? this.chain.dispose();
    await this.finalDisposal;
  }

  private summary(binding: WorkspaceBinding): WorkspaceSummary {
    return {
      uri: workspaceUri(binding.target),
      generation: asGeneration(this.generation),
      availability: this.availability,
    };
  }

  private refreshAvailability(): void {
    const next: WorkspaceAvailability = this.chain.isHealthy(this.active)
      ? { kind: "available" }
      : { kind: "unavailable", reason: "SSH route or mount health check failed" };
    if (next.kind === "available" && this.availability.kind === "available") return;
    if (
      next.kind === "unavailable"
      && this.availability.kind === "unavailable"
      && next.reason === this.availability.reason
    ) return;
    this.availability = next;
    this.generation += 1;
  }

  private assertCurrent(generation: WorkspaceGeneration): void {
    this.assertLive();
    this.refreshAvailability();
    if (generation !== asGeneration(this.generation)) {
      throw new StaleWorkspaceAccessError(
        `Termia rejected stale Active Workspace access for ${workspaceUri(this.active.target)}`,
      );
    }
  }

  private unavailableMessage(): string {
    const uri = workspaceUri(this.active.target);
    const detail = this.availability.kind === "unavailable"
      ? `: ${this.availability.reason}`
      : "";
    return `Termia Active Workspace ${uri} is unavailable${detail}; close the failed SSH hop in the terminal or run /termia reset`;
  }

  private assertLive(): void {
    if (this.disposed) {
      throw new StaleWorkspaceAccessError("Termia Active Workspace has been disposed");
    }
  }

  private assertPreparationCurrent(
    ticketEpoch: number,
    preparedAt: number,
    uri: string,
  ): void {
    if (
      this.disposed
      || ticketEpoch !== this.activationEpoch
      || preparedAt !== this.topologyRevision
    ) {
      throw new StaleActivationError(
        `Termia rejected stale Active Workspace activation for ${uri}`,
      );
    }
  }

  private traversesRemoteMount(binding: WorkspaceBinding, input: string): boolean {
    if (!isAbsolute(input)) return true;
    if (binding.target.scheme !== "ssh" || binding.mountRoot === undefined) return false;
    const location = relative(binding.mountRoot, resolve(input));
    return location === ""
      || (location !== ".." && !location.startsWith(`..${sep}`) && !isAbsolute(location));
  }
}

export function createActiveWorkspace(
  cwd: string,
  detached: DetachedCommandOperations,
  mounts?: MountOperations,
  identities?: IdentityOperations,
): { workspace: ActiveWorkspace; terminal: TerminalWorkspaceFeed } {
  const state = new ActiveWorkspaceState(cwd, detached, mounts, identities);
  return {
    workspace: {
      current: () => state.current(),
      prepare: (shellId) => state.prepare(shellId),
      [Symbol.asyncDispose]: () => state.dispose(),
    },
    terminal: {
      resetRoot: (rootCwd, shellId) => state.resetRoot(rootCwd, shellId),
      openSsh: (event) => state.openSsh(event),
      openIdentity: (event, privateKey) => state.openIdentity(event, privateKey),
      updateCwd: (shellId, updatedCwd) => state.updateCwd(shellId, updatedCwd),
      close: (shellId) => state.close(shellId),
      contextFor: (shellId, contextCwd) => state.contextFor(shellId, contextCwd),
      localCwd: () => state.localCwd(),
      terminalExited: () => state.terminalExited(),
    },
  };
}
