import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionCommandContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { spawn, type IDisposable, type IPty } from "node-pty";
import { AgentJobSelector, AgentJobSelectorModel, type AgentJobView } from "./agent-job-ui.ts";
import type { CommandRecord } from "./history.ts";
import { HistoryStore } from "./history.ts";
import { ProtocolParser, type ProtocolToken, type QuickAskRequest } from "./protocol.ts";
import { SshChain, type MountOperations } from "./ssh-workspace.ts";
import { fileWorkspace, projectWorkspacePath, type WorkspaceBinding } from "./workspace.ts";

type TerminalContext = Pick<ExtensionCommandContext, "ui">;
type CommandListener = (command: CommandRecord) => void;
type QuickAskListener = (request: QuickAskRequest) => void;
type PromptBoundary = { cwd: string; outputOffset: number };
export type TerminalAttachExit =
  | { type: "detach"; shellId: string }
  | { type: "quickAsk"; request: QuickAskRequest };
export type TerminalEnterOptions = {
  refresh?: boolean;
  onQuickAskAbort?: () => void;
};
export type ExecuteOptions = {
  isolated?: boolean;
  onOutput?: (data: string) => void;
  signal?: AbortSignal;
};
export type AgentExecuteOptions = {
  onOutput?: (data: Buffer) => void;
  signal?: AbortSignal;
};
export type AgentExecutionResult = { exitCode: number };
type ActiveExecution = {
  command: string;
  isolated: boolean;
  sequence: { shellId: string; value: number } | undefined;
  written: boolean;
  aborting: boolean;
  onOutput: ((data: string) => void) | undefined;
  signal: AbortSignal | undefined;
  abort: () => void;
  resolve: (record: CommandRecord) => void;
  reject: (error: Error) => void;
};
type AgentExecution = {
  id: number;
  shellId: string;
  command: string;
  cwd: string;
  startedAt: number;
  processGroupId: number | undefined;
  transcriptPath: Promise<string> | undefined;
  transcriptOffset: number;
  screenOffset: number;
  transcriptPump: Promise<void> | undefined;
  status: "launching" | "running" | "waiting" | "foreground" | "ended";
  launchWritten: boolean;
  payloadWritten: boolean;
  aborting: boolean;
  killTimer: NodeJS.Timeout | undefined;
  onOutput: ((data: Buffer) => void) | undefined;
  signal: AbortSignal | undefined;
  abort: () => void;
  resolve: (result: AgentExecutionResult) => void;
  reject: (error: Error) => void;
};
type AgentControl = {
  run: () => boolean;
  onReady: (() => void) | undefined;
  onCancel?: () => void;
};

const SHELL_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "./shell");
const EXPLICIT_EXEC_CHUNK_SIZE = 256;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function shellHook(shell: string): "ash" | "bash" | "zsh" {
  const name = basename(shell);
  if (name === "ash" || name === "bash" || name === "zsh") return name;
  if (name === "sh") {
    try {
      if (basename(realpathSync(shell)) === "busybox") return "ash";
    } catch {}
  }
  throw new Error(`Unsupported shell: ${name}`);
}

export function isTermiaPty(marker = process.env.TERMIA_PTY): boolean {
  return marker === "1";
}

export class TerminalController {
  private readonly parser = new ProtocolParser();
  private readonly listeners = new Set<CommandListener>();
  private readonly quickAskListeners = new Set<QuickAskListener>();
  private readonly history: HistoryStore;
  private readonly sshChain: SshChain;
  private subscriptions: IDisposable[] = [];
  private pty: IPty | undefined;
  private execution: ActiveExecution | undefined;
  private detach: ((result: TerminalAttachExit) => void) | undefined;
  private resumeTui: (() => void) | undefined;
  private activeQuickAsk: QuickAskRequest | undefined;
  private quickAskControlExited = false;
  private attached = false;
  private shellReady = false;
  private cwdValue = process.cwd();
  private activeShellId = "local";
  private readonly shellParents = new Map<string, string>();
  private readonly explicitExecutionShells = new Set<string>();
  private readonly promptBoundaries = new Map<string, PromptBoundary>();
  private readonly observedHistoryIds = new Map<string, number>();
  private readonly manualCommandStartedAt = new Map<string, number>();
  private readonly agentExecutions = new Map<number, AgentExecution>();
  private readonly agentControlQueue: AgentControl[] = [];
  private nextAgentJobId = 1;
  private agentPollTimer: NodeJS.Timeout | undefined;
  private agentTranscriptTimer: NodeJS.Timeout | undefined;
  private agentControlActive: AgentControl | undefined;
  private agentControlMuted = false;
  private ui: ExtensionUIContext | undefined;
  private agentInteraction: Promise<void> | undefined;
  private agentInteractionTimer: NodeJS.Timeout | undefined;
  private activeAgentForeground: AgentExecution | undefined;
  private agentScreenWrite: ((data: Buffer) => void) | undefined;
  private agentRawFinish: (() => void) | undefined;
  private agentSelectorFinish: (() => void) | undefined;

  constructor(history: HistoryStore, mounts?: MountOperations) {
    this.history = history;
    this.sshChain = new SshChain(fileWorkspace(process.cwd()), "local", mounts);
  }

  get cwd(): string {
    return this.cwdValue;
  }

  get running(): boolean {
    return this.pty !== undefined;
  }

  get workspace(): WorkspaceBinding {
    return this.sshChain.currentBinding;
  }

  readyWorkspace(shellId: string): Promise<WorkspaceBinding> {
    return this.sshChain.readyBinding(shellId);
  }

  nearestLiveWorkspace(): WorkspaceBinding {
    return this.sshChain.nearestLiveBinding();
  }

  isWorkspaceHealthy(binding: WorkspaceBinding): boolean {
    return this.sshChain.isHealthy(binding);
  }

  assertWorkspace(cwd: string): void {
    this.sshChain.assertPhysicalWorkspace(cwd);
  }

  start(cwd: string, shell = process.env.SHELL ?? "/bin/bash"): void {
    if (this.pty !== undefined) return;
    if (!statSync(cwd).isDirectory()) throw new Error(`Not a directory: ${cwd}`);
    const hook = shellHook(shell);

    const terminalId = randomUUID();
    this.sshChain.resetRoot(fileWorkspace(cwd), terminalId);
    this.history.startTerminal({ id: terminalId, shell, cwd });
    let child: IPty;
    try {
      child = spawn(shell, ["-i"], {
        name: process.env.TERM ?? "xterm-256color",
        cols: process.stdout.columns ?? 80,
        rows: process.stdout.rows ?? 24,
        cwd,
        env: {
          ...process.env,
          TERMIA_PTY: "1",
          TERMIA_SHELL_ID: terminalId,
          TERMIA_HOOK_DIR: SHELL_DIRECTORY,
        },
      });
    } catch (error) {
      this.history.endTerminal();
      throw error;
    }

    this.cwdValue = resolve(cwd);
    this.activeShellId = terminalId;
    this.shellParents.clear();
    this.explicitExecutionShells.clear();
    this.promptBoundaries.clear();
    this.observedHistoryIds.clear();
    this.manualCommandStartedAt.clear();
    this.shellReady = false;
    this.pty = child;
    this.subscriptions = [
      child.onData((data: string) => this.consume(data)),
      child.onExit(() => this.finish(child)),
    ];
    child.write(` . ${shellQuote(resolve(SHELL_DIRECTORY, `termia.${hook}`))}\r`);
  }

  write(data: string | Buffer): void {
    if (this.pty === undefined) throw new Error("Termia shell is not running");
    const submitted = typeof data === "string"
      ? data.includes("\r") || data.includes("\n")
      : data.includes(0x0d) || data.includes(0x0a);
    if (submitted && this.explicitExecutionShells.has(this.activeShellId)) {
      this.shellReady = false;
      if (!this.manualCommandStartedAt.has(this.activeShellId)) {
        this.manualCommandStartedAt.set(this.activeShellId, Date.now());
      }
    }
    this.pty.write(data);
  }

  async execute(command: string, options: ExecuteOptions = {}): Promise<CommandRecord> {
    if (command.trim().length === 0) throw new Error("Termia command cannot be empty");
    if (command.includes("\u0000")) throw new Error("Termia command cannot contain NUL bytes");
    if (this.pty === undefined) throw new Error("Termia shell is not running");
    if (this.attached && this.activeQuickAsk === undefined) {
      throw new Error("Termia terminal is attached");
    }
    if (this.execution !== undefined) throw new Error("A Termia command is already running");
    options.signal?.throwIfAborted();

    return new Promise((resolveExecution, rejectExecution) => {
      const abort = () => {
        if (this.execution === execution) {
          if (!execution.written) {
            this.clearExecution(execution);
            execution.reject(new Error("Termia command was aborted before execution"));
            return;
          }
          execution.aborting = true;
          if (execution.written) this.pty?.write("\u0003");
        }
      };
      const execution: ActiveExecution = {
        command,
        isolated: options.isolated === true,
        sequence: undefined,
        written: false,
        aborting: false,
        onOutput: options.onOutput,
        signal: options.signal,
        abort,
        resolve: resolveExecution,
        reject: rejectExecution,
      };
      this.execution = execution;
      execution.signal?.addEventListener("abort", abort, { once: true });
      if (this.shellReady) this.writeExecution(execution);
    });
  }

  async executeAgent(
    command: string,
    options: AgentExecuteOptions = {},
  ): Promise<AgentExecutionResult> {
    if (command.trim().length === 0) throw new Error("Termia command cannot be empty");
    if (command.includes("\u0000")) throw new Error("Termia command cannot contain NUL bytes");
    if (this.pty === undefined) throw new Error("Termia shell is not running");
    if (this.attached || this.activeQuickAsk !== undefined) {
      throw new Error("Termia terminal is attached");
    }

    const id = this.nextAgentJobId++;
    return new Promise((resolveExecution, rejectExecution) => {
      const execution: AgentExecution = {
        id,
        shellId: this.activeShellId,
        command,
        cwd: this.cwdValue,
        startedAt: Date.now(),
        processGroupId: undefined,
        transcriptPath: undefined,
        transcriptOffset: 0,
        screenOffset: 0,
        transcriptPump: undefined,
        status: "launching",
        launchWritten: false,
        payloadWritten: false,
        aborting: false,
        killTimer: undefined,
        onOutput: options.onOutput,
        signal: options.signal,
        abort: () => this.abortAgentExecution(execution),
        resolve: resolveExecution,
        reject: rejectExecution,
      };
      this.agentExecutions.set(id, execution);
      execution.signal?.addEventListener("abort", execution.abort, { once: true });
      this.enqueueAgentControl({
        run: () => {
          if (!this.agentExecutions.has(id)) return false;
          execution.launchWritten = true;
          this.pty?.write(`__termia_agent_stream ${id}\r`);
          return true;
        },
        onReady: () => {
          if (!this.agentExecutions.has(id) || execution.processGroupId !== undefined) return;
          this.finishAgentExecutionBeforeStart(
            execution,
            execution.aborting
              ? new Error("Termia Agent command was aborted before execution")
              : new Error("Termia Agent command failed to start"),
          );
        },
      });
      this.scheduleAgentPoll();
      this.startAgentTranscriptPump();
      if (execution.signal?.aborted) execution.abort();
    });
  }

  async restoreCwd(cwd: string): Promise<void> {
    const target = resolve(cwd);
    await this.execute(`cd -- ${shellQuote(target)}`);
    if (this.cwdValue !== target) {
      throw new Error(`Termia shell did not restore cwd to ${target}`);
    }
  }

  onCommand(listener: CommandListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onQuickAsk(listener: QuickAskListener): () => void {
    this.quickAskListeners.add(listener);
    return () => this.quickAskListeners.delete(listener);
  }

  setUi(ui: ExtensionUIContext | undefined): void {
    this.ui = ui;
    if (ui === undefined) {
      this.agentSelectorFinish?.();
      this.agentRawFinish?.();
    }
    else this.scheduleAgentInteraction();
  }

  completeQuickAsk(exitCode: number, output = ""): void {
    if (this.activeQuickAsk === undefined) throw new Error("No Termia quick ask is active");
    if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) {
      throw new Error("Quick ask exit code must be an integer between 0 and 255");
    }
    if (output.length > 0) this.history.appendOutput(output);
    const execution = this.execution;
    if (execution !== undefined) {
      if (execution.sequence !== undefined) this.pty?.write("\u0003");
      this.clearExecution(execution);
      execution.reject(new Error("Termia quick ask ended while a command was running"));
    }
    this.activeQuickAsk = undefined;
    if (this.quickAskControlExited) {
      this.quickAskControlExited = false;
      this.write("\r");
      return;
    }
    this.shellReady = false;
    this.write(`D;${exitCode}\r`);
  }

  async enter(ctx: TerminalContext, options: TerminalEnterOptions = {}): Promise<TerminalAttachExit> {
    if (this.pty === undefined) {
      this.resumeUi();
      throw new Error("Termia shell is not running");
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      this.resumeUi();
      throw new Error("Termia terminal mode requires a TTY");
    }
    if (this.attached) throw new Error("Termia terminal is already attached");
    this.attached = true;

    try {
      return await ctx.ui.custom<TerminalAttachExit>((tui, _theme, _keys, done) => {
        const previousRawMode = process.stdin.isRaw;
        let finished = false;
        let resumed = false;
        const resume = () => {
          if (resumed) return;
          resumed = true;
          if (this.resumeTui === resume) this.resumeTui = undefined;
          tui.start();
          tui.requestRender(true);
        };
        const finish = (
          result: TerminalAttachExit = { type: "detach", shellId: this.activeShellId },
        ) => {
          if (finished) return;
          finished = true;
          this.attached = false;
          this.detach = undefined;
          process.stdin.off("data", onInput);
          process.off("SIGWINCH", onResize);
          try {
            process.stdin.setRawMode(previousRawMode);
          } finally {
            if (result.type === "quickAsk") this.resumeTui = resume;
            else resume();
            done(result);
          }
        };
        const onInput = (chunk: Buffer | string) => {
          const data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
          if (this.activeQuickAsk !== undefined) {
            if (data.includes(0x03)) options.onQuickAskAbort?.();
            return;
          }
          const escape = data.indexOf(0x1d);
          if (escape < 0) {
            this.write(data);
            return;
          }
          if (escape > 0) this.write(data.subarray(0, escape));
          finish();
        };
        const onResize = () => {
          this.pty?.resize(process.stdout.columns ?? 80, process.stdout.rows ?? 24);
        };

        try {
          tui.stop();
          this.resumeTui = undefined;
          if (options.refresh !== false) process.stdout.write("\u001b[2J\u001b[H");
          process.stdin.setRawMode(true);
          process.stdin.on("data", onInput);
          process.stdin.resume();
          process.on("SIGWINCH", onResize);
          this.detach = finish;
          onResize();
          if (options.refresh !== false) this.pty?.write("\u000c");
        } catch (error) {
          finish();
          throw error;
        }

        return { render: () => [], invalidate: () => {}, dispose: finish };
      });
    } catch (error) {
      this.attached = false;
      this.resumeUi();
      throw error;
    }
  }

  resumeUi(): void {
    this.resumeTui?.();
  }

  dispose(): void {
    const child = this.pty;
    if (child !== undefined) {
      child.kill();
      this.finish(child);
    }
    void this.sshChain.dispose();
    this.resumeUi();
  }

  async disposeWorkspaces(): Promise<void> {
    await this.sshChain.dispose();
  }

  private enqueueAgentControl(control: AgentControl): void {
    this.agentControlQueue.push(control);
    this.flushAgentControl();
  }

  private flushAgentControl(): void {
    if (
      this.pty === undefined
      || !this.shellReady
      || this.agentControlMuted
      || this.execution !== undefined
      || this.attached
      || this.activeQuickAsk !== undefined
    ) return;
    for (;;) {
      const control = this.agentControlQueue.shift();
      if (control === undefined) return;
      this.agentControlMuted = true;
      this.agentControlActive = control;
      this.shellReady = false;
      if (control.run()) return;
      this.agentControlMuted = false;
      this.agentControlActive = undefined;
      this.shellReady = true;
    }
  }

  private startAgentTranscriptPump(): void {
    if (this.agentTranscriptTimer !== undefined) return;
    this.agentTranscriptTimer = setInterval(() => {
      for (const execution of this.agentExecutions.values()) {
        void this.pumpAgentTranscript(execution, false).catch(() => {});
      }
    }, 50);
  }

  private scheduleAgentPoll(): void {
    if (this.agentPollTimer !== undefined || this.agentExecutions.size === 0) return;
    this.agentPollTimer = setTimeout(() => {
      this.agentPollTimer = undefined;
      if (this.agentExecutions.size === 0) return;
      this.enqueueAgentControl({
        run: () => {
          if (this.agentExecutions.size === 0) return false;
          this.pty?.write("__termia_agent_poll\r");
          return true;
        },
        onReady: () => this.scheduleAgentPoll(),
      });
    }, 50);
  }

  private async pumpAgentTranscript(execution: AgentExecution, final: boolean): Promise<void> {
    const transcriptPath = execution.transcriptPath;
    if (transcriptPath === undefined) return;
    if (execution.transcriptPump !== undefined) {
      if (!final) return;
      await execution.transcriptPump;
    }
    const pump = (async () => {
      const path = await transcriptPath;
      let handle;
      try {
        handle = await open(path, "r");
        const size = (await handle.stat()).size;
        if (size <= execution.transcriptOffset) return;
        const offset = execution.transcriptOffset;
        const data = Buffer.allocUnsafe(size - offset);
        const { bytesRead } = await handle.read(
          data,
          0,
          data.length,
          offset,
        );
        execution.transcriptOffset += bytesRead;
        if (bytesRead > 0) {
          const output = data.subarray(0, bytesRead);
          execution.onOutput?.(output);
          if (
            this.activeAgentForeground === execution
            && execution.status === "foreground"
            && this.agentScreenWrite !== undefined
          ) {
            const screenStart = Math.max(execution.screenOffset, offset);
            const screenEnd = offset + bytesRead;
            if (screenStart < screenEnd) {
              this.agentScreenWrite(output.subarray(screenStart - offset));
              execution.screenOffset = screenEnd;
            }
          }
        }
      } catch (error) {
        if (!final && (error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      } finally {
        await handle?.close();
      }
    })();
    execution.transcriptPump = pump;
    try {
      await pump;
    } finally {
      if (execution.transcriptPump === pump) execution.transcriptPump = undefined;
    }
  }

  private async readAgentScreenTranscript(execution: AgentExecution): Promise<Buffer> {
    await this.pumpAgentTranscript(execution, false);
    const transcriptPath = execution.transcriptPath;
    const end = execution.transcriptOffset;
    if (transcriptPath === undefined || end <= execution.screenOffset) return Buffer.alloc(0);
    const handle = await open(await transcriptPath, "r");
    try {
      const data = Buffer.allocUnsafe(end - execution.screenOffset);
      const { bytesRead } = await handle.read(data, 0, data.length, execution.screenOffset);
      execution.screenOffset += bytesRead;
      return data.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  private runAgentControl(command: string): Promise<void> {
    return new Promise((resolveControl) => {
      this.enqueueAgentControl({
        run: () => {
          if (this.pty === undefined) {
            resolveControl();
            return false;
          }
          this.pty.write(`${command}\r`);
          return true;
        },
        onReady: resolveControl,
        onCancel: resolveControl,
      });
    });
  }

  private waitingAgentJobs(): AgentExecution[] {
    return [...this.agentExecutions.values()].filter((execution) => execution.status === "waiting");
  }

  private scheduleAgentInteraction(): void {
    if (
      this.agentInteraction !== undefined
      || this.agentInteractionTimer !== undefined
      || this.ui === undefined
      || this.waitingAgentJobs().length === 0
    ) return;
    this.agentInteractionTimer = setTimeout(() => {
      this.agentInteractionTimer = undefined;
      if (this.agentInteraction !== undefined || this.ui === undefined) return;
      if (this.waitingAgentJobs().length === 0) return;
      const interaction = this.runAgentInteraction();
      this.agentInteraction = interaction;
      const finish = () => {
        if (this.agentInteraction === interaction) this.agentInteraction = undefined;
        this.scheduleAgentInteraction();
      };
      void interaction.then(finish, finish);
    }, 20);
  }

  private async runAgentInteraction(): Promise<void> {
    const ui = this.ui;
    if (ui === undefined || !process.stdin.isTTY || !process.stdout.isTTY) return;
    const waiting = this.waitingAgentJobs();
    let jobId = waiting[0]?.id;
    if (waiting.length > 1) {
      const views: AgentJobView[] = waiting.map((execution) => ({
        id: execution.id,
        command: execution.command,
        cwd: execution.cwd,
        startedAt: execution.startedAt,
        status: "waiting",
      }));
      jobId = await ui.custom<number>(
        (_tui, theme, _keys, done) => {
          const finish = (selected: number) => {
            if (this.agentSelectorFinish === cancel) this.agentSelectorFinish = undefined;
            done(selected);
          };
          const cancel = () => finish(-1);
          this.agentSelectorFinish = cancel;
          return new AgentJobSelector(new AgentJobSelectorModel(views), theme, finish);
        },
        {
          overlay: true,
          overlayOptions: { width: "80%", minWidth: 48, maxHeight: "80%" },
        },
      );
    }
    const execution = jobId === undefined ? undefined : this.agentExecutions.get(jobId);
    if (execution === undefined || execution.status !== "waiting") return;
    const initialOutput = await this.readAgentScreenTranscript(execution);
    let menuRequested = false;
    let rawStarted: (() => void) | undefined;
    const started = new Promise<void>((resolveStarted) => {
      rawStarted = resolveStarted;
    });
    this.activeAgentForeground = execution;
    const raw = ui.custom<void>((tui, _theme, _keys, done) => {
      const previousRawMode = process.stdin.isRaw;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (this.agentRawFinish === finish) this.agentRawFinish = undefined;
        this.agentScreenWrite = undefined;
        process.stdin.off("data", onInput);
        try {
          process.stdin.setRawMode(previousRawMode);
        } finally {
          tui.start();
          tui.requestRender(true);
          done();
        }
      };
      const onInput = (chunk: Buffer | string) => {
        const data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        const forwarded: number[] = [];
        for (const byte of data) {
          if (byte === 0x1d) continue;
          if (byte === 0x07) {
            if (forwarded.length > 0) this.pty?.write(Buffer.from(forwarded));
            menuRequested = true;
            this.pty?.write("\u001a");
            return;
          }
          forwarded.push(byte);
        }
        if (forwarded.length > 0) this.pty?.write(Buffer.from(forwarded));
      };
      try {
        tui.stop();
        process.stdin.setRawMode(true);
        process.stdin.on("data", onInput);
        process.stdin.resume();
        if (initialOutput.length > 0) process.stdout.write(initialOutput);
        this.agentScreenWrite = (data) => process.stdout.write(data);
        this.agentRawFinish = finish;
        rawStarted?.();
      } catch (error) {
        finish();
        throw error;
      }
      return { render: () => [], invalidate: () => {}, dispose: finish };
    });
    await started;
    const foreground = this.runAgentControl(`__termia_agent_foreground ${execution.id}`);
    void foreground.then(
      () => this.agentRawFinish?.(),
      () => this.agentRawFinish?.(),
    );
    await raw;
    await foreground;
    if (this.activeAgentForeground === execution) this.activeAgentForeground = undefined;
    if (menuRequested && this.agentExecutions.has(execution.id)) {
      execution.status = "running";
      await this.runAgentControl(`__termia_agent_background ${execution.id}`);
      if (this.agentExecutions.has(execution.id)) execution.status = "waiting";
    }
  }

  private abortAgentExecution(execution: AgentExecution): void {
    if (!this.agentExecutions.has(execution.id) || execution.aborting) return;
    execution.aborting = true;
    if (!execution.launchWritten) {
      this.finishAgentExecutionBeforeStart(
        execution,
        new Error("Termia Agent command was aborted before execution"),
      );
      return;
    }
    if (!execution.payloadWritten) return;
    if (execution.processGroupId === undefined) {
      this.pty?.write("\u0003");
      return;
    }
    void this.signalAgentExecution(execution, "INT").catch(() => {});
    execution.killTimer = setTimeout(() => {
      if (!this.agentExecutions.has(execution.id)) return;
      void this.signalAgentExecution(execution, "KILL").catch(() => {});
    }, 500);
  }

  private async signalAgentExecution(
    execution: AgentExecution,
    signal: "INT" | "KILL",
  ): Promise<void> {
    const processGroupId = execution.processGroupId;
    if (processGroupId === undefined) return;
    try {
      if (this.sshChain.contextFor(execution.shellId).hopChain.length === 0) {
        process.kill(-processGroupId, signal === "INT" ? "SIGINT" : "SIGKILL");
      } else {
        await this.sshChain.signalProcessGroup(execution.shellId, processGroupId, signal);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  private finishAgentExecutionBeforeStart(execution: AgentExecution, error: Error): void {
    if (!this.agentExecutions.delete(execution.id)) return;
    execution.status = "ended";
    execution.signal?.removeEventListener("abort", execution.abort);
    if (execution.killTimer !== undefined) clearTimeout(execution.killTimer);
    execution.reject(error);
    this.finishAgentControlLifecycle();
  }

  private async finishAgentExecution(execution: AgentExecution, exitCode: number): Promise<void> {
    if (!this.agentExecutions.has(execution.id) || execution.status === "ended") return;
    execution.status = "ended";
    if (execution.killTimer !== undefined) clearTimeout(execution.killTimer);
    try {
      await this.pumpAgentTranscript(execution, true);
    } catch (error) {
      if (!this.agentExecutions.delete(execution.id)) return;
      execution.signal?.removeEventListener("abort", execution.abort);
      execution.reject(error instanceof Error ? error : new Error(String(error)));
      this.finishAgentControlLifecycle();
      return;
    }
    if (!this.agentExecutions.delete(execution.id)) return;
    execution.signal?.removeEventListener("abort", execution.abort);
    execution.resolve({ exitCode });
    this.finishAgentControlLifecycle();
  }

  private finishAgentControlLifecycle(): void {
    if (this.agentExecutions.size > 0) {
      this.scheduleAgentPoll();
      return;
    }
    if (this.agentPollTimer !== undefined) clearTimeout(this.agentPollTimer);
    this.agentPollTimer = undefined;
    if (this.agentTranscriptTimer !== undefined) clearInterval(this.agentTranscriptTimer);
    this.agentTranscriptTimer = undefined;
    if (this.agentInteractionTimer !== undefined) clearTimeout(this.agentInteractionTimer);
    this.agentInteractionTimer = undefined;
    this.agentSelectorFinish?.();
    this.enqueueAgentControl({
      run: () => {
        this.pty?.write("__termia_agent_cleanup\r");
        return this.pty !== undefined;
      },
      onReady: undefined,
    });
  }

  private failAgentExecutions(error: Error): void {
    if (this.agentPollTimer !== undefined) clearTimeout(this.agentPollTimer);
    this.agentPollTimer = undefined;
    if (this.agentTranscriptTimer !== undefined) clearInterval(this.agentTranscriptTimer);
    this.agentTranscriptTimer = undefined;
    if (this.agentInteractionTimer !== undefined) clearTimeout(this.agentInteractionTimer);
    this.agentInteractionTimer = undefined;
    this.agentControlActive?.onCancel?.();
    for (const control of this.agentControlQueue) control.onCancel?.();
    this.agentControlQueue.length = 0;
    this.agentControlActive = undefined;
    this.agentControlMuted = false;
    this.agentRawFinish?.();
    this.agentSelectorFinish?.();
    this.agentSelectorFinish = undefined;
    this.agentRawFinish = undefined;
    this.agentScreenWrite = undefined;
    this.activeAgentForeground = undefined;
    for (const execution of this.agentExecutions.values()) {
      execution.status = "ended";
      execution.signal?.removeEventListener("abort", execution.abort);
      if (execution.killTimer !== undefined) clearTimeout(execution.killTimer);
      execution.onOutput = undefined;
      execution.reject(error);
    }
    this.agentExecutions.clear();
  }

  private consume(data: string): void {
    for (const token of this.parser.push(data)) this.consumeToken(token);
  }

  private consumeToken(token: ProtocolToken): void {
    switch (token.type) {
      case "output":
        if (
          this.activeAgentForeground !== undefined
          && this.activeAgentForeground.status === "foreground"
        ) {
          const output = Buffer.from(token.data);
          this.activeAgentForeground.onOutput?.(output);
          this.agentScreenWrite?.(output);
          break;
        }
        if (this.agentControlMuted) break;
        this.history.appendOutput(token.data);
        if (this.execution?.sequence !== undefined) {
          this.execution.onOutput?.(token.data);
        }
        if (this.attached && this.activeQuickAsk === undefined) {
          process.stdout.write(token.data);
        }
        break;
      case "ready":
        this.activeShellId = token.shellId;
        if (token.explicitExec === true) {
          this.explicitExecutionShells.add(token.shellId);
          this.promptBoundaries.set(token.shellId, {
            cwd: token.cwd,
            outputOffset: this.history.outputOffset,
          });
          this.manualCommandStartedAt.delete(token.shellId);
        }
        this.cwdValue = token.cwd;
        this.sshChain.updateCwd(token.shellId, token.cwd);
        this.shellReady = true;
        if (this.agentControlMuted) {
          const control = this.agentControlActive;
          this.agentControlMuted = false;
          this.agentControlActive = undefined;
          control?.onReady?.();
        }
        if (
          this.execution?.aborting
          && this.execution.sequence !== undefined
          && (
            this.activeQuickAsk !== undefined
            || this.explicitExecutionShells.has(token.shellId)
          )
        ) {
          this.quickAskControlExited = true;
          this.consumeToken({
            type: "end",
            shellId: this.execution.sequence.shellId,
            sequence: this.execution.sequence.value,
            cwd: token.cwd,
            exitCode: 130,
          });
        }
        if (this.execution?.aborting && this.execution.sequence === undefined) {
          const execution = this.execution;
          this.clearExecution(execution);
          execution.reject(new Error("Termia command was aborted before execution"));
        } else if (this.execution !== undefined && !this.execution.written) {
          this.writeExecution(this.execution);
        }
        this.flushAgentControl();
        break;
      case "agentJobTransportReady": {
        const execution = this.agentExecutions.get(token.jobId);
        if (
          execution === undefined
          || execution.shellId !== token.shellId
          || !execution.launchWritten
          || execution.payloadWritten
        ) break;
        execution.payloadWritten = true;
        if (execution.aborting) {
          this.pty?.write("%\r");
          break;
        }
        const encoded = Buffer.from(execution.command, "utf8").toString("base64");
        for (let offset = 0; offset < encoded.length; offset += EXPLICIT_EXEC_CHUNK_SIZE) {
          this.pty?.write(`${encoded.slice(offset, offset + EXPLICIT_EXEC_CHUNK_SIZE)}\r`);
        }
        this.pty?.write(".\r");
        break;
      }
      case "agentJobStart": {
        const execution = this.agentExecutions.get(token.jobId);
        if (execution === undefined || execution.shellId !== token.shellId) break;
        execution.processGroupId = token.processGroupId;
        execution.status = "running";
        execution.transcriptPath = this.sshChain.readyBinding(token.shellId).then((binding) =>
          projectWorkspacePath(binding, token.transcriptPath)
        );
        void this.pumpAgentTranscript(execution, false).catch(() => {});
        if (execution.aborting) {
          void this.signalAgentExecution(execution, "INT").catch(() => {});
          execution.killTimer = setTimeout(() => {
            if (!this.agentExecutions.has(execution.id)) return;
            void this.signalAgentExecution(execution, "KILL").catch(() => {});
          }, 500);
        }
        break;
      }
      case "agentJobWaiting": {
        const execution = this.agentExecutions.get(token.jobId);
        if (execution !== undefined && execution.shellId === token.shellId) {
          execution.status = "waiting";
          this.scheduleAgentInteraction();
        }
        break;
      }
      case "agentJobForeground": {
        const execution = this.agentExecutions.get(token.jobId);
        if (execution !== undefined && execution.shellId === token.shellId) {
          execution.status = "foreground";
          this.activeAgentForeground = execution;
        }
        break;
      }
      case "agentJobBackground": {
        const execution = this.agentExecutions.get(token.jobId);
        if (execution !== undefined && execution.shellId === token.shellId) {
          execution.status = "running";
          if (this.activeAgentForeground === execution) this.agentRawFinish?.();
        }
        break;
      }
      case "agentJobEnd": {
        const execution = this.agentExecutions.get(token.jobId);
        if (execution !== undefined && execution.shellId === token.shellId) {
          if (this.activeAgentForeground === execution) this.agentRawFinish?.();
          void this.finishAgentExecution(execution, token.exitCode);
        }
        break;
      }
      case "start":
        this.activeShellId = token.shellId;
        this.shellReady = false;
        if (this.execution !== undefined && this.execution.sequence === undefined) {
          this.execution.sequence = { shellId: token.shellId, value: token.sequence };
          this.history.startCommand(
            { ...token, command: this.execution.command },
            this.sshChain.contextFor(token.shellId, token.cwd),
          );
          if (this.execution.aborting) this.pty?.write("\u0003");
        } else {
          this.history.startCommand(token, this.sshChain.contextFor(token.shellId, token.cwd));
        }
        break;
      case "end": {
        this.activeShellId = token.shellId;
        this.cwdValue = token.cwd;
        this.sshChain.updateCwd(token.shellId, token.cwd);
        const command = this.history.endCommand(token);
        if (command !== undefined) {
          for (const listener of this.listeners) listener(command);
          if (
            this.execution?.sequence?.shellId === token.shellId
            && this.execution.sequence.value === token.sequence
          ) {
            const execution = this.execution;
            if (this.activeQuickAsk !== undefined) this.shellReady = true;
            this.clearExecution(execution);
            execution.resolve(command);
          }
        }
        break;
      }
      case "observed": {
        if (this.observedHistoryIds.get(token.shellId) === token.historyId) break;
        this.observedHistoryIds.set(token.shellId, token.historyId);
        const boundary = this.promptBoundaries.get(token.shellId);
        if (boundary === undefined) break;
        const endedAt = Date.now();
        const command = this.history.recordObservedCommand(
          token,
          this.sshChain.contextFor(token.shellId, boundary.cwd),
          boundary,
          this.manualCommandStartedAt.get(token.shellId) ?? endedAt,
          endedAt,
        );
        this.manualCommandStartedAt.delete(token.shellId);
        this.activeShellId = token.shellId;
        this.cwdValue = token.cwd;
        this.sshChain.updateCwd(token.shellId, token.cwd);
        for (const listener of this.listeners) listener(command);
        break;
      }
      case "quickAsk":
        if (this.activeQuickAsk !== undefined) break;
        this.activeShellId = token.shellId;
        this.cwdValue = token.cwd;
        this.activeQuickAsk = token;
        this.quickAskControlExited = false;
        this.shellReady = true;
        for (const listener of this.quickAskListeners) listener(this.activeQuickAsk);
        this.detach?.({ type: "quickAsk", request: this.activeQuickAsk });
        break;
      case "sshOpen":
        try {
          this.sshChain.open(token);
          this.history.discardActiveCommand(token.parentShellId);
        } catch (error) {
          const message = `termia: ignored SSH workspace event: ${error instanceof Error ? error.message : String(error)}\n`;
          this.history.appendOutput(message);
          if (this.attached) process.stderr.write(message);
          break;
        }
        this.shellParents.set(token.shellId, token.parentShellId);
        this.activeShellId = token.shellId;
        this.cwdValue = token.cwd;
        break;
      case "sshClose": {
        const parent = this.shellParents.get(token.shellId);
        this.shellParents.delete(token.shellId);
        this.explicitExecutionShells.delete(token.shellId);
        this.promptBoundaries.delete(token.shellId);
        this.observedHistoryIds.delete(token.shellId);
        this.manualCommandStartedAt.delete(token.shellId);
        if (this.activeShellId === token.shellId && parent !== undefined) this.activeShellId = parent;
        void this.sshChain.close(token.shellId).catch(() => {});
        break;
      }
    }
  }

  private finish(child: IPty): void {
    if (this.pty !== child) return;
    for (const token of this.parser.flush()) this.consumeToken(token);
    for (const subscription of this.subscriptions) subscription.dispose();
    this.subscriptions = [];
    this.pty = undefined;
    this.shellReady = false;
    this.activeQuickAsk = undefined;
    this.quickAskControlExited = false;
    this.activeShellId = "local";
    this.shellParents.clear();
    this.explicitExecutionShells.clear();
    this.promptBoundaries.clear();
    this.observedHistoryIds.clear();
    this.manualCommandStartedAt.clear();
    this.history.endTerminal();
    void this.sshChain.dispose();
    this.failAgentExecutions(new Error("Termia shell exited while an Agent command was running"));
    const execution = this.execution;
    if (execution !== undefined) {
      this.clearExecution(execution);
      execution.reject(new Error("Termia shell exited while a command was running"));
    }
    this.detach?.({ type: "detach", shellId: this.activeShellId });
    this.resumeUi();
  }

  private clearExecution(execution: ActiveExecution): void {
    execution.signal?.removeEventListener("abort", execution.abort);
    if (this.execution === execution) this.execution = undefined;
  }

  private writeExecution(execution: ActiveExecution): void {
    if (this.execution !== execution || execution.written) return;
    execution.written = true;
    this.shellReady = false;
    const command = execution.isolated ? `(${execution.command})` : execution.command;
    if (this.activeQuickAsk === undefined) {
      if (this.explicitExecutionShells.has(this.activeShellId)) {
        const encoded = Buffer.from(command, "utf8").toString("base64");
        this.pty?.write("__termia_exec_stream\r");
        for (let offset = 0; offset < encoded.length; offset += EXPLICIT_EXEC_CHUNK_SIZE) {
          const chunk = encoded.slice(offset, offset + EXPLICIT_EXEC_CHUNK_SIZE);
          this.pty?.write(`${chunk}\r`);
        }
        this.pty?.write(".\r");
      } else {
        this.pty?.write(`eval -- ${shellQuote(command)}\r`);
      }
      return;
    }
    const encoded = Buffer.from(command, "utf8").toString("base64");
    this.pty?.write(`X;${encoded}\r`);
  }
}
