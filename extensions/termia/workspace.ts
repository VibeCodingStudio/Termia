import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export type SshHop = {
  shellId: string;
  parentShellId: string;
  destination: string;
  user: string;
  host: string;
  port: number;
  controlPath: string;
};

export type WorkspaceTarget =
  | { scheme: "file"; path: string }
  | { scheme: "ssh"; hops: readonly SshHop[]; path: string };

export type WorkspaceBinding = {
  target: WorkspaceTarget;
  piCwd: string;
  mountRoot?: string;
};

const FILE_TOOLS = new Set(["read", "edit", "write", "grep", "find", "ls"]);
const WORKSPACE_TOOLS = new Set([...FILE_TOOLS, "bash"]);
const DISCONNECTED_REASON = "Termia SSH workspace is disconnected; run /termia to return to the nearest live workspace";
const TILDE_REASON = "Termia cannot map ~ paths safely; use an absolute remote path";

export function fileWorkspace(path: string): WorkspaceBinding {
  const absolute = resolve(path);
  return { target: { scheme: "file", path: absolute }, piCwd: absolute };
}

export function sshWorkspace(
  hops: readonly SshHop[],
  remotePath: string,
  mountRoot: string,
): WorkspaceBinding {
  if (hops.length === 0) throw new Error("An SSH workspace requires at least one hop");
  const path = posix.resolve("/", remotePath);
  const root = resolve(mountRoot);
  return {
    target: { scheme: "ssh", hops: [...hops], path },
    piCwd: resolve(root, `.${path}`),
    mountRoot: root,
  };
}

export function workspaceUri(target: WorkspaceTarget): string {
  if (target.scheme === "file") return pathToFileURL(target.path).href;
  const hop = target.hops.at(-1);
  if (hop === undefined) throw new Error("An SSH workspace requires a leaf hop");
  const port = hop.port === 22 ? "" : `:${hop.port}`;
  const host = hop.host.includes(":") ? `[${hop.host}]` : hop.host;
  const uri = new URL(`ssh://${encodeURIComponent(hop.user)}@${host}${port}/`);
  uri.pathname = target.path;
  return uri.href;
}

export function projectWorkspacePath(binding: WorkspaceBinding, input: string): string {
  if (input.includes("\0")) throw new Error("Workspace path cannot contain NUL bytes");
  if (binding.target.scheme !== "ssh") return input;
  if (binding.mountRoot === undefined) throw new Error("Termia SSH workspace has no mount root");
  const path = input.startsWith("@") ? input.slice(1) : input;
  if (path.startsWith("/")) return resolve(binding.mountRoot, `.${posix.resolve("/", path)}`);
  const location = relative(binding.mountRoot, resolve(binding.piCwd, path));
  if (location !== ".." && !location.startsWith(`..${sep}`) && !isAbsolute(location)) return input;
  return resolve(binding.mountRoot, `.${posix.resolve(binding.target.path, path)}`);
}

export function presentWorkspaceCwd(prompt: string, binding: WorkspaceBinding): string {
  if (binding.target.scheme !== "ssh") return prompt;
  const physicalCwd = binding.piCwd.replaceAll("\\", "/");
  return prompt.replace(
    `Current working directory: ${physicalCwd}`,
    `Current working directory: ${workspaceUri(binding.target)}`,
  );
}

export function applyWorkspaceToolPolicy(
  event: { toolName: string; input: Record<string, unknown> },
  binding: WorkspaceBinding,
  healthy: boolean,
): { block: boolean; reason?: string } {
  if (binding.target.scheme !== "ssh" || !WORKSPACE_TOOLS.has(event.toolName)) return { block: false };
  if (!healthy) return { block: true, reason: DISCONNECTED_REASON };
  if (FILE_TOOLS.has(event.toolName) && typeof event.input.path === "string") {
    if (/^@?~(?:\/|$)/.test(event.input.path)) return { block: true, reason: TILDE_REASON };
    event.input.path = projectWorkspacePath(binding, event.input.path);
  }
  return { block: false };
}
