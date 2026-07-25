import { execFile, spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
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
import { delimiter, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import type { IdentityOpenEvent, SshOpenEvent } from "./protocol.ts";
import {
  fileWorkspace,
  sshWorkspace,
  workspaceUri,
  type SshHop,
  type WorkspaceBinding,
} from "./workspace.ts";

const MOUNT_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 3_000;
const CONTROL_START_TIMEOUT_MS = 10_000;
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
  return `ssh -T -S ${quote(parent.controlPath)} ${quote(parent.destination)} ${quote(`exec ${command}`)}`;
}

export function activeRoute(hops: readonly SshHop[]): readonly SshHop[] {
  let start = 0;
  for (let index = 0; index < hops.length; index += 1) {
    if (hops[index]?.localAnchor === true) start = index;
  }
  return hops.slice(start);
}

export function buildRemoteExecCommand(hops: readonly SshHop[], remoteCommand: string): string {
  hops = activeRoute(hops);
  const leaf = hops.at(-1);
  if (leaf === undefined) throw new Error("Cannot execute without an SSH hop");
  validateField("remote command", remoteCommand);
  for (const hop of hops) validateHop(hop);
  let command = `ssh -T -S ${quote(leaf.controlPath)} ${quote(leaf.destination)} ${quote(remoteCommand)}`;
  for (let index = hops.length - 2; index >= 0; index -= 1) {
    const parent = hops[index];
    if (parent === undefined) throw new Error("Invalid SSH hop chain");
    command = wrapRemote(parent, command);
  }
  return command;
}

export function buildRemoteStreamCommand(
  hops: readonly SshHop[],
  host: string,
  port: number,
): string {
  hops = activeRoute(hops);
  const leaf = hops.at(-1);
  if (leaf === undefined) throw new Error("Cannot stream without an SSH hop");
  validateField("stream host", host);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("SSH stream port must be between 1 and 65535");
  }
  for (const hop of hops) validateHop(hop);
  const endpoint = `${host.includes(":") ? `[${host}]` : host}:${port}`;
  let command = `ssh -S ${quote(leaf.controlPath)} -W ${quote(endpoint)} ${quote(leaf.destination)}`;
  for (let index = hops.length - 2; index >= 0; index -= 1) {
    const parent = hops[index];
    if (parent === undefined) throw new Error("Invalid SSH hop chain");
    command = wrapRemote(parent, command);
  }
  return command;
}

export function buildRemoteBashCommand(
  hops: readonly SshHop[],
  cwd: string,
  command: string,
): string {
  validateField("cwd", cwd);
  if (!posix.isAbsolute(cwd)) throw new Error("SSH cwd must be absolute");
  if (command.includes("\0")) throw new Error("SSH command cannot contain NUL bytes");
  const payload = Buffer.from(command).toString("base64");
  const decode = "if command -v base64 >/dev/null 2>&1; then if base64 -d </dev/null >/dev/null 2>&1; then base64 -d; elif base64 --decode </dev/null >/dev/null 2>&1; then base64 --decode; else base64 -D; fi; else ucode -e 'let fs = require(\"fs\"); print(b64dec(fs.readfile(\"/dev/stdin\")))'; fi";
  const remoteCommand = [
    `cd -- ${quote(cwd)} || exit`,
    `__termia_command=$(printf '%s' ${quote(payload)} | { ${decode}; }) || exit`,
    `[ -z "\${SHELL-}" ] || [ ! -x "$SHELL" ] || exec "$SHELL" -c "$__termia_command"`,
    `exec /bin/sh -c "$__termia_command"`,
  ].join("; ");
  return buildRemoteExecCommand(hops, remoteCommand);
}

export function buildSftpBridgeScript(hops: readonly SshHop[]): string {
  hops = activeRoute(hops);
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
  hops = activeRoute(hops);
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

async function requireLocalCommand(command: string): Promise<void> {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    try {
      await access(join(directory || ".", command), constants.X_OK);
      return;
    } catch {}
  }
  throw new Error(`${command} is required on the machine running Pi`);
}

type IdentityState = {
  runtime: string;
  controlPath: string;
  destination: string;
};

function identityAlias(shellId: string): string {
  return `termia-identity-${shellId.replace(/[^A-Za-z0-9.-]/g, "-")}`;
}

function identityHop(event: IdentityOpenEvent, parent: SshHop, controlPath: string): SshHop {
  return {
    shellId: event.shellId,
    parentShellId: event.parentShellId,
    destination: `${event.user}@${identityAlias(event.shellId)}`,
    user: event.user,
    host: parent.host,
    port: parent.port,
    controlPath,
    localAnchor: true,
  };
}

export interface IdentityOperations {
  open(event: IdentityOpenEvent, parentHops: readonly SshHop[], privateKey: string): Promise<SshHop>;
  close(shellId: string): Promise<void>;
  dispose(): Promise<void>;
}

export class IdentityTransport {
  private readonly identities = new Map<string, IdentityState>();

  async open(
    event: IdentityOpenEvent,
    parentHops: readonly SshHop[],
    privateKey: string,
  ): Promise<SshHop> {
    const parent = parentHops.at(-1);
    if (parent === undefined || parent.shellId !== event.parentShellId) {
      throw new Error("Identity workspace parent is not the current SSH leaf");
    }
    if (this.identities.has(event.shellId)) {
      throw new Error(`Identity shell is already open: ${event.shellId}`);
    }
    validateField("identity shell id", event.shellId);
    validateField("identity user", event.user);
    if (!/^[A-Za-z0-9._-]+$/.test(event.user)) throw new Error("Invalid identity user");
    if (!isAbsolute(privateKey)) throw new Error("Identity private key must be absolute");
    await access(privateKey, constants.R_OK);
    await requireLocalCommand("ssh");

    const runtime = await mkdtemp(join(tmpdir(), "termia-identity-"));
    await chmod(runtime, 0o700);
    const alias = identityAlias(event.shellId);
    const destination = `${event.user}@${alias}`;
    const controlPath = join(runtime, "control");
    const bridgePath = join(runtime, "route.bridge");
    const knownHostsPath = join(runtime, "identity.known_hosts");
    try {
      await writeFile(
        bridgePath,
        `#!/bin/sh\nexec ${buildRemoteStreamCommand(parentHops, "127.0.0.1", event.port)}\n`,
        { mode: 0o700 },
      );
      await writeFile(knownHostsPath, `${alias} ${event.hostKey}\n`, { mode: 0o600 });
      await runFile("ssh", [
        "-M", "-S", controlPath,
        "-o", "ControlMaster=yes",
        "-o", "ControlPersist=no",
        "-o", `ProxyCommand=exec ${quote(bridgePath)}`,
        "-o", "IdentitiesOnly=yes",
        "-i", privateKey,
        "-o", "PasswordAuthentication=no",
        "-o", "KbdInteractiveAuthentication=no",
        "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=yes",
        "-o", "GlobalKnownHostsFile=/dev/null",
        "-o", `HostKeyAlias=${alias}`,
        "-o", `UserKnownHostsFile=${knownHostsPath}`,
        "-fN", destination,
      ], CONTROL_START_TIMEOUT_MS);
      this.identities.set(event.shellId, { runtime, controlPath, destination });
      return identityHop(event, parent, controlPath);
    } catch (error) {
      await rm(runtime, { recursive: true, force: true });
      throw error;
    }
  }

  async close(shellId: string): Promise<void> {
    const state = this.identities.get(shellId);
    if (state === undefined) return;
    this.identities.delete(shellId);
    await runFile(
      "ssh",
      ["-S", state.controlPath, "-O", "exit", state.destination],
      STOP_TIMEOUT_MS,
    ).catch(() => {});
    await rm(state.runtime, { recursive: true, force: true });
  }

  async dispose(): Promise<void> {
    for (const shellId of [...this.identities.keys()].reverse()) await this.close(shellId);
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
    await requireLocalCommand("sshfs");
    if (process.platform !== "darwin") await requireLocalCommand("fusermount3");

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
  identity: boolean;
  routeReady: boolean;
  routeTask: Promise<void>;
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
  private readonly identities: IdentityOperations;
  private readonly hops: HopState[] = [];

  constructor(
    rootBinding: WorkspaceBinding,
    rootShellId: string,
    mounts: MountOperations = new WorkspaceMount(),
    identities: IdentityOperations = new IdentityTransport(),
  ) {
    this.rootBinding = rootBinding;
    this.rootShellId = rootShellId;
    this.mounts = mounts;
    this.identities = identities;
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
    const { type: _type, cwd, ...eventHop } = event;
    const hop: SshHop = this.hops.length === 0
      ? { ...eventHop, localAnchor: true }
      : eventHop;
    const state: HopState = {
      hop,
      cwd,
      identity: false,
      routeReady: this.hops.at(-1)?.routeReady ?? true,
      routeTask: this.hops.at(-1)?.routeTask ?? Promise.resolve(),
      binding: undefined,
      mountTask: Promise.resolve(),
      error: undefined,
    };
    this.hops.push(state);
    const states = [...this.hops];
    const mount = () => this.mounts.mount(states.map((entry) => entry.hop), cwd);
    const mountTask = state.routeReady ? mount() : state.routeTask.then(mount);
    state.mountTask = mountTask.then(
      (binding) => {
        state.binding = this.mounts.updateCwd(binding, state.cwd);
      },
      (error: unknown) => {
        state.error = error;
      },
    );
  }

  openIdentity(event: IdentityOpenEvent, privateKey: string): void {
    const parentState = this.hops.at(-1);
    const expectedParent = parentState?.hop.shellId ?? this.rootShellId;
    if (event.parentShellId !== expectedParent || parentState === undefined) {
      throw new Error(`Identity hop parent ${event.parentShellId} is not the current SSH leaf ${expectedParent}`);
    }
    if (this.hops.some((state) => state.hop.shellId === event.shellId)) {
      throw new Error(`Identity shell is already in the hop chain: ${event.shellId}`);
    }
    if (!/^[A-Za-z0-9._-]+$/.test(event.user)) throw new Error("Invalid identity user");
    const parentStates = [...this.hops];
    const state: HopState = {
      hop: identityHop(event, parentState.hop, join(tmpdir(), "termia-identity-pending", "control")),
      cwd: event.cwd,
      identity: true,
      routeReady: false,
      routeTask: Promise.resolve(),
      binding: undefined,
      mountTask: Promise.resolve(),
      error: undefined,
    };
    this.hops.push(state);
    state.routeTask = (async () => {
      await parentState.routeTask;
      state.hop = await this.identities.open(
        event,
        parentStates.map((entry) => entry.hop),
        privateKey,
      );
      state.routeReady = true;
    })();
    state.mountTask = (async () => {
      try {
        await state.routeTask;
        const binding = await this.mounts.mount([...parentStates.map((entry) => entry.hop), state.hop], state.cwd);
        state.binding = this.mounts.updateCwd(binding, state.cwd);
      } catch (error) {
        state.error = error;
      }
    })();
  }

  async close(shellId: string): Promise<void> {
    const leaf = this.hops.at(-1);
    if (leaf === undefined || leaf.hop.shellId !== shellId) {
      throw new Error(`SSH shell is not the current leaf: ${shellId}`);
    }
    this.hops.pop();
    await leaf.mountTask;
    await this.mounts.unmount(shellId);
    if (leaf.identity) await this.identities.close(shellId);
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
      if (state.identity) {
        await this.identities.close(state.hop.shellId).catch(() => {});
      } else {
        const chain = states.slice(0, index + 1).map((entry) => entry.hop);
        await runFile("/bin/sh", ["-c", buildControlExitCommand(chain)], STOP_TIMEOUT_MS).catch(() => {});
      }
    }
    await this.mounts.dispose();
    await this.identities.dispose();
  }
}
