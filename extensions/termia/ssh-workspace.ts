import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SshOpenEvent } from "./protocol.ts";
import {
  fileWorkspace,
  sshWorkspace,
  workspaceUri,
  type SshHop,
  type WorkspaceBinding,
} from "./workspace.ts";

const MOUNT_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 3_000;
const WORKSPACE_ROOT = join(tmpdir(), "termia-ssh");

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateField(name: string, value: string): void {
  if (value.includes("\0")) throw new Error(`SSH ${name} cannot contain NUL bytes`);
  if (value.includes("\n") || value.includes("\r")) {
    throw new Error(`SSH ${name} cannot contain a newline`);
  }
}

function validateHop(hop: SshHop): void {
  validateField("destination", hop.destination);
  validateField("control path", hop.controlPath);
  if (!isAbsolute(hop.controlPath)) throw new Error("SSH control path must be absolute");
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function wrapRemote(parent: SshHop, command: string): string {
  return `ssh -S ${quote(parent.controlPath)} ${quote(parent.destination)} ${quote(`exec ${command}`)}`;
}

export function buildRemoteExecCommand(hops: readonly SshHop[], remoteCommand: string): string {
  const leaf = hops.at(-1);
  if (leaf === undefined) throw new Error("Cannot execute without an SSH hop");
  validateField("remote command", remoteCommand);
  for (const hop of hops) validateHop(hop);
  let command = `ssh -S ${quote(leaf.controlPath)} ${quote(leaf.destination)} ${quote(`exec ${remoteCommand}`)}`;
  for (let index = hops.length - 2; index >= 0; index -= 1) {
    const parent = hops[index];
    if (parent === undefined) throw new Error("Invalid SSH hop chain");
    command = wrapRemote(parent, command);
  }
  return command;
}

export function buildSftpBridgeScript(hops: readonly SshHop[]): string {
  const leaf = hops.at(-1);
  if (leaf === undefined) throw new Error("Cannot build an SFTP bridge without an SSH hop");
  for (const hop of hops) validateHop(hop);
  let command = `ssh -S ${quote(leaf.controlPath)} -s ${quote(leaf.destination)} sftp`;
  for (let index = hops.length - 2; index >= 0; index -= 1) {
    const parent = hops[index];
    if (parent === undefined) throw new Error("Invalid SSH hop chain");
    command = wrapRemote(parent, command);
  }
  return `#!/bin/sh\nexec ${command}\n`;
}

export function workspaceMountName(hops: readonly SshHop[]): string {
  const leaf = hops.at(-1);
  if (leaf === undefined) throw new Error("Cannot name a mount without an SSH hop");
  const port = leaf.port === 22 ? "" : `-p${leaf.port}`;
  const identity = `${leaf.user}@${leaf.host}${port}`.replace(/[^A-Za-z0-9._@-]/g, "_");
  return `${hops.length}-${identity}`;
}

export function workspaceMountPath(hops: readonly SshHop[]): string {
  return join(WORKSPACE_ROOT, workspaceMountName(hops));
}

function buildControlExitCommand(hops: readonly SshHop[]): string {
  const leaf = hops.at(-1);
  if (leaf === undefined) throw new Error("Cannot close an empty SSH hop chain");
  for (const hop of hops) validateHop(hop);
  let command = `ssh -S ${quote(leaf.controlPath)} -O exit ${quote(leaf.destination)}`;
  for (let index = hops.length - 2; index >= 0; index -= 1) {
    const parent = hops[index];
    if (parent === undefined) throw new Error("Invalid SSH hop chain");
    command = wrapRemote(parent, command);
  }
  return command;
}

type MountState = {
  shellId: string;
  directory: string;
  mountRoot: string;
  bridgePath: string;
  probePath: string;
  child: ChildProcess;
  healthy: boolean;
};

export interface MountOperations {
  mount(hops: readonly SshHop[], cwd: string): Promise<WorkspaceBinding>;
  updateCwd(binding: WorkspaceBinding, cwd: string): WorkspaceBinding;
  unmount(shellId: string): Promise<void>;
  health(shellId: string): boolean;
  dispose(): Promise<void>;
}

function runFile(command: string, args: readonly string[], timeout: number): Promise<void> {
  return new Promise((resolveRun, rejectRun) => {
    execFile(command, args, { timeout }, (error) => {
      if (error === null) resolveRun();
      else rejectRun(error);
    });
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function isMountPoint(path: string): Promise<boolean> {
  try {
    const [entry, parent] = await Promise.all([stat(path), stat(dirname(path))]);
    return entry.dev !== parent.dev;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function waitForExit(child: ChildProcess, timeout: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
    delay(timeout),
  ]);
}

export async function prepareWorkspaceMountPath(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  const command = process.platform === "darwin" ? "umount" : "fusermount3";
  const args = process.platform === "darwin" ? ["-f", path] : ["-uz", path];
  await runFile(command, args, STOP_TIMEOUT_MS).catch(() => {});
  if (await isMountPoint(path)) {
    throw new Error(`Termia SSH workspace remains mounted after takeover: ${path}`);
  }
  await rm(path, { recursive: true, force: true });
  await mkdir(path, { mode: 0o700 });
}

export class WorkspaceMount implements MountOperations {
  private runtimeRoot: string | undefined;
  private readonly mounts = new Map<string, MountState>();

  async mount(hops: readonly SshHop[], cwd: string): Promise<WorkspaceBinding> {
    const leaf = hops.at(-1);
    if (leaf === undefined) throw new Error("Cannot mount an empty SSH hop chain");
    if (this.mounts.has(leaf.shellId)) throw new Error(`SSH shell is already mounted: ${leaf.shellId}`);

    const runtimeRoot = await this.ensureRuntimeRoot();
    const mountRoot = workspaceMountPath(hops);
    const directory = mountRoot;
    const bridgePath = join(runtimeRoot, `${workspaceMountName(hops)}.bridge`);
    const probePath = join(mountRoot, `.termia-probe-${leaf.shellId}`);
    await mkdir(WORKSPACE_ROOT, { recursive: true, mode: 0o700 });
    await prepareWorkspaceMountPath(mountRoot);
    try {
      await writeFile(bridgePath, buildSftpBridgeScript(hops), { mode: 0o700 });
      await writeFile(probePath, "", { mode: 0o600 });
    } catch (error) {
      await rm(mountRoot, { recursive: true, force: true });
      await rm(bridgePath, { force: true });
      throw error;
    }

    const child = spawn("sshfs", [
      "termia:/",
      mountRoot,
      "-f",
      "-s",
      "-o", `ssh_command=${bridgePath}`,
      "-o", "sshfs_sync",
      "-o", "transform_symlinks",
    ], { stdio: ["ignore", "ignore", "pipe"] });
    const state: MountState = {
      shellId: leaf.shellId,
      directory,
      mountRoot,
      bridgePath,
      probePath,
      child,
      healthy: true,
    };
    this.mounts.set(leaf.shellId, state);
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8_192);
    });
    child.once("error", () => {
      state.healthy = false;
    });
    child.once("exit", () => {
      state.healthy = false;
    });

    const binding = sshWorkspace(hops, cwd, mountRoot);
    try {
      const startedAt = Date.now();
      while (await exists(probePath)) {
        if (!state.healthy || child.exitCode !== null) {
          throw new Error(stderr.trim() || "sshfs exited before the mount became ready");
        }
        if (Date.now() - startedAt >= MOUNT_TIMEOUT_MS) {
          throw new Error("timed out waiting for sshfs mount");
        }
        await delay(50);
      }
      const cwdStat = await stat(binding.piCwd);
      if (!cwdStat.isDirectory()) throw new Error(`Remote cwd is not a directory: ${cwd}`);
      return binding;
    } catch (error) {
      state.healthy = false;
      await this.unmount(leaf.shellId).catch(() => {});
      throw new Error(`Termia SSH workspace unavailable: ${errorMessage(error)}`, { cause: error });
    }
  }

  updateCwd(binding: WorkspaceBinding, cwd: string): WorkspaceBinding {
    if (binding.target.scheme !== "ssh" || binding.mountRoot === undefined) return binding;
    return sshWorkspace(binding.target.hops, cwd, binding.mountRoot);
  }

  health(shellId: string): boolean {
    const state = this.mounts.get(shellId);
    return state !== undefined
      && state.healthy
      && state.child.exitCode === null
      && state.child.signalCode === null;
  }

  async unmount(shellId: string): Promise<void> {
    const state = this.mounts.get(shellId);
    if (state === undefined) return;
    state.healthy = false;
    if (state.child.exitCode === null && state.child.signalCode === null) state.child.kill("SIGTERM");
    await waitForExit(state.child, STOP_TIMEOUT_MS);
    const command = process.platform === "darwin" ? "umount" : "fusermount3";
    await runFile(command, ["-u", state.mountRoot], STOP_TIMEOUT_MS).catch(() => {});
    if (!(await exists(state.probePath))) {
      throw new Error(`Refusing to remove a mount that is still active: ${state.mountRoot}`);
    }
    this.mounts.delete(shellId);
    await rm(state.directory, { recursive: true, force: true });
    await rm(state.bridgePath, { force: true });
  }

  async dispose(): Promise<void> {
    for (const shellId of [...this.mounts.keys()].reverse()) {
      await this.unmount(shellId).catch(() => {});
    }
    if (this.mounts.size === 0 && this.runtimeRoot !== undefined) {
      await rm(this.runtimeRoot, { recursive: true, force: true });
      this.runtimeRoot = undefined;
    }
  }

  private async ensureRuntimeRoot(): Promise<string> {
    if (this.runtimeRoot !== undefined) return this.runtimeRoot;
    const root = await mkdtemp(join(tmpdir(), "termia-ssh-"));
    await chmod(root, 0o700);
    this.runtimeRoot = root;
    return root;
  }
}

type HopState = {
  hop: SshHop;
  cwd: string;
  binding: WorkspaceBinding | undefined;
  mountTask: Promise<void>;
  error: unknown;
};

export type WorkspaceContext = {
  workspaceUri: string;
  hopChain: string[];
};

export class SshChain {
  private rootBinding: WorkspaceBinding;
  private rootShellId: string;
  private readonly mounts: MountOperations;
  private readonly hops: HopState[] = [];

  constructor(rootBinding: WorkspaceBinding, rootShellId: string, mounts: MountOperations = new WorkspaceMount()) {
    this.rootBinding = rootBinding;
    this.rootShellId = rootShellId;
    this.mounts = mounts;
  }

  get currentBinding(): WorkspaceBinding {
    return this.nearestLiveBinding();
  }

  resetRoot(binding: WorkspaceBinding, shellId: string): void {
    if (this.hops.length > 0) throw new Error("Cannot reset the local workspace while SSH hops are active");
    this.rootBinding = binding;
    this.rootShellId = shellId;
  }

  open(event: SshOpenEvent): void {
    const expectedParent = this.hops.at(-1)?.hop.shellId ?? this.rootShellId;
    if (event.parentShellId !== expectedParent) {
      throw new Error(`SSH hop parent ${event.parentShellId} is not the current leaf ${expectedParent}`);
    }
    if (this.hops.some((state) => state.hop.shellId === event.shellId)) {
      throw new Error(`SSH shell is already in the hop chain: ${event.shellId}`);
    }
    const { type: _type, cwd, ...hop } = event;
    const state: HopState = {
      hop,
      cwd,
      binding: undefined,
      mountTask: Promise.resolve(),
      error: undefined,
    };
    this.hops.push(state);
    state.mountTask = this.mounts.mount(this.hops.map((entry) => entry.hop), cwd).then(
      (binding) => {
        state.binding = this.mounts.updateCwd(binding, state.cwd);
      },
      (error: unknown) => {
        state.error = error;
      },
    );
  }

  async close(shellId: string): Promise<void> {
    const leaf = this.hops.at(-1);
    if (leaf === undefined || leaf.hop.shellId !== shellId) {
      throw new Error(`SSH shell is not the current leaf: ${shellId}`);
    }
    this.hops.pop();
    await leaf.mountTask;
    await this.mounts.unmount(shellId);
  }

  async readyBinding(shellId: string): Promise<WorkspaceBinding> {
    if (shellId === this.rootShellId) return this.rootBinding;
    const state = this.hops.find((entry) => entry.hop.shellId === shellId);
    if (state === undefined) throw new Error(`Unknown Termia shell: ${shellId}`);
    await state.mountTask;
    if (state.error !== undefined) {
      throw new Error(`Termia SSH workspace unavailable: ${errorMessage(state.error)}`, { cause: state.error });
    }
    if (state.binding === undefined || !this.mounts.health(shellId)) {
      throw new Error("Termia SSH workspace unavailable: sshfs is disconnected");
    }
    return state.binding;
  }

  updateCwd(shellId: string, cwd: string): void {
    if (shellId === this.rootShellId) {
      this.rootBinding = fileWorkspace(cwd);
      return;
    }
    const state = this.hops.find((entry) => entry.hop.shellId === shellId);
    if (state === undefined) return;
    state.cwd = cwd;
    if (state.binding !== undefined) state.binding = this.mounts.updateCwd(state.binding, cwd);
  }

  nearestLiveBinding(): WorkspaceBinding {
    for (let index = this.hops.length - 1; index >= 0; index -= 1) {
      const state = this.hops[index];
      if (
        state?.binding !== undefined
        && state.error === undefined
        && this.mounts.health(state.hop.shellId)
      ) return state.binding;
    }
    return this.rootBinding;
  }

  contextFor(shellId: string, cwd?: string): WorkspaceContext {
    if (shellId === this.rootShellId) {
      const binding = cwd === undefined ? this.rootBinding : fileWorkspace(cwd);
      return { workspaceUri: workspaceUri(binding.target), hopChain: [] };
    }
    const index = this.hops.findIndex((entry) => entry.hop.shellId === shellId);
    if (index < 0) throw new Error(`Unknown Termia shell: ${shellId}`);
    const states = this.hops.slice(0, index + 1);
    const target = sshWorkspace(states.map((state) => state.hop), cwd ?? states[index]!.cwd, "/").target;
    return {
      workspaceUri: workspaceUri(target),
      hopChain: states.map((state) => state.hop.destination),
    };
  }

  async signalProcessGroup(
    shellId: string,
    processGroupId: number,
    signal: "INT" | "KILL",
  ): Promise<void> {
    if (!Number.isSafeInteger(processGroupId) || processGroupId <= 0) {
      throw new Error("Invalid Agent process group");
    }
    if (signal !== "INT" && signal !== "KILL") throw new Error("Invalid Agent signal");
    const index = this.hops.findIndex((state) => state.hop.shellId === shellId);
    if (index < 0) throw new Error(`Unknown SSH shell: ${shellId}`);
    const hops = this.hops.slice(0, index + 1).map((state) => state.hop);
    await runFile(
      "/bin/sh",
      ["-c", buildRemoteExecCommand(hops, `kill -${signal} -${processGroupId}`)],
      STOP_TIMEOUT_MS,
    );
  }

  isHealthy(binding: WorkspaceBinding): boolean {
    if (binding.target.scheme === "file") return true;
    const shellId = binding.target.hops.at(-1)?.shellId;
    return shellId !== undefined && this.mounts.health(shellId);
  }

  assertPhysicalWorkspace(cwd: string): void {
    const target = resolve(cwd);
    for (let index = this.hops.length - 1; index >= 0; index -= 1) {
      const state = this.hops[index];
      if (state === undefined) continue;
      const mountRoot = state.binding?.mountRoot;
      if (mountRoot === undefined) continue;
      const location = relative(mountRoot, target);
      if (location === ".." || location.startsWith(`..${sep}`) || isAbsolute(location)) continue;
      if (!this.mounts.health(state.hop.shellId)) {
        throw new Error("Termia SSH workspace is disconnected");
      }
      return;
    }
    if (this.hops.length > 0) {
      throw new Error(`Termia command cwd is outside the active workspace: ${cwd}`);
    }
  }

  async dispose(): Promise<void> {
    const states = [...this.hops];
    this.hops.length = 0;
    for (let index = states.length - 1; index >= 0; index -= 1) {
      const state = states[index];
      if (state === undefined) continue;
      await state.mountTask;
      await this.mounts.unmount(state.hop.shellId).catch(() => {});
      const chain = states.slice(0, index + 1).map((entry) => entry.hop);
      await runFile("/bin/sh", ["-c", buildControlExitCommand(chain)], STOP_TIMEOUT_MS).catch(() => {});
    }
    await this.mounts.dispose();
  }
}
