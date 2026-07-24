import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { spawn, type IDisposable, type IPty } from "node-pty";
import type { CommandRecord } from "./history.ts";
import { HistoryStore } from "./history.ts";
import { ProtocolParser, type ProtocolToken } from "./protocol.ts";
import { SshChain, type MountOperations } from "./ssh-workspace.ts";
import { fileWorkspace, type WorkspaceBinding } from "./workspace.ts";

type TerminalContext = Pick<ExtensionCommandContext, "ui">;
type CommandListener = (command: CommandRecord) => void;
type PromptBoundary = { cwd: string; outputOffset: number };
export type TerminalAttachExit = { type: "detach"; shellId: string };
export type ExecuteOptions = {
  onOutput?: (data: string) => void;
  signal?: AbortSignal;
};
type ActiveExecution = {
  command: string;
  sequence: { shellId: string; value: number } | undefined;
  written: boolean;
  aborting: boolean;
  onOutput: ((data: string) => void) | undefined;
  signal: AbortSignal | undefined;
  abort: () => void;
  resolve: (record: CommandRecord) => void;
  reject: (error: Error) => void;
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
  private readonly history: HistoryStore;
  private readonly sshChain: SshChain;
  private subscriptions: IDisposable[] = [];
  private pty: IPty | undefined;
  private execution: ActiveExecution | undefined;
  private detach: ((result: TerminalAttachExit) => void) | undefined;
  private attached = false;
  private shellReady = false;
  private cwdValue = process.cwd();
  private activeShellId = "local";
  private readonly shellParents = new Map<string, string>();
  private readonly explicitExecutionShells = new Set<string>();
  private readonly promptBoundaries = new Map<string, PromptBoundary>();
  private readonly observedHistoryIds = new Map<string, number>();
  private readonly manualCommandStartedAt = new Map<string, number>();

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
    if (this.attached) throw new Error("Termia terminal is attached");
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

  async enter(ctx: TerminalContext): Promise<TerminalAttachExit> {
    if (this.pty === undefined) {
      throw new Error("Termia shell is not running");
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error("Termia terminal mode requires a TTY");
    }
    if (this.attached) throw new Error("Termia terminal is already attached");
    this.attached = true;

    try {
      return await ctx.ui.custom<TerminalAttachExit>((tui, _theme, _keys, done) => {
        const previousRawMode = process.stdin.isRaw;
        let finished = false;
        const resume = () => {
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
            resume();
            done(result);
          }
        };
        const onInput = (chunk: Buffer | string) => {
          const data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
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
          process.stdout.write("\u001b[2J\u001b[H");
          process.stdin.setRawMode(true);
          process.stdin.on("data", onInput);
          process.stdin.resume();
          process.on("SIGWINCH", onResize);
          this.detach = finish;
          onResize();
          this.pty?.write("\u000c");
        } catch (error) {
          finish();
          throw error;
        }

        return { render: () => [], invalidate: () => {}, dispose: finish };
      });
    } catch (error) {
      this.attached = false;
      throw error;
    }
  }

  dispose(): void {
    const child = this.pty;
    if (child !== undefined) {
      child.kill();
      this.finish(child);
    }
    void this.sshChain.dispose();
  }

  async disposeWorkspaces(): Promise<void> {
    await this.sshChain.dispose();
  }

  private consume(data: string): void {
    for (const token of this.parser.push(data)) this.consumeToken(token);
  }

  private consumeToken(token: ProtocolToken): void {
    switch (token.type) {
      case "output":
        this.history.appendOutput(token.data);
        if (this.execution?.sequence !== undefined) {
          this.execution.onOutput?.(token.data);
        }
        if (this.attached) process.stdout.write(token.data);
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
        if (
          this.execution?.aborting
          && this.execution.sequence !== undefined
          && this.explicitExecutionShells.has(token.shellId)
        ) {
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
        break;
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
    this.activeShellId = "local";
    this.shellParents.clear();
    this.explicitExecutionShells.clear();
    this.promptBoundaries.clear();
    this.observedHistoryIds.clear();
    this.manualCommandStartedAt.clear();
    this.history.endTerminal();
    void this.sshChain.dispose();
    const execution = this.execution;
    if (execution !== undefined) {
      this.clearExecution(execution);
      execution.reject(new Error("Termia shell exited while a command was running"));
    }
    this.detach?.({ type: "detach", shellId: this.activeShellId });
  }

  private clearExecution(execution: ActiveExecution): void {
    execution.signal?.removeEventListener("abort", execution.abort);
    if (this.execution === execution) this.execution = undefined;
  }

  private writeExecution(execution: ActiveExecution): void {
    if (this.execution !== execution || execution.written) return;
    execution.written = true;
    this.shellReady = false;
    if (this.explicitExecutionShells.has(this.activeShellId)) {
      const encoded = Buffer.from(execution.command, "utf8").toString("base64");
      this.pty?.write("__termia_exec_stream\r");
      for (let offset = 0; offset < encoded.length; offset += EXPLICIT_EXEC_CHUNK_SIZE) {
        const chunk = encoded.slice(offset, offset + EXPLICIT_EXEC_CHUNK_SIZE);
        this.pty?.write(`${chunk}\r`);
      }
      this.pty?.write(".\r");
    } else {
      this.pty?.write(`eval -- ${shellQuote(execution.command)}\r`);
    }
  }
}
