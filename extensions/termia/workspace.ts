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
  localAnchor?: true;
};

export type WorkspaceTarget =
  | { scheme: "file"; path: string }
  | { scheme: "ssh"; hops: readonly SshHop[]; path: string };

export type WorkspaceBinding = {
  target: WorkspaceTarget;
  piCwd: string;
  mountRoot?: string;
};

const URI_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const SSH_PATH_GUIDANCE = [
  "Termia SSH file paths:",
  "- Relative file paths use the active SSH cwd.",
  "- Local absolute paths stay local.",
  "- Remote absolute paths use ssh://user@host/path.",
].join("\n");

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

function parseSshUri(input: string): URL | undefined {
  if (!/^ssh:/i.test(input)) {
    if (URI_SCHEME.test(input)) {
      throw new Error(`Unsupported workspace URI: ${input}; use a local absolute path or ssh://`);
    }
    return undefined;
  }
  let uri: URL;
  try {
    uri = new URL(input);
  } catch {
    throw new Error(`Invalid SSH workspace URI: ${input}`);
  }
  if (uri.protocol !== "ssh:" || uri.hostname.length === 0) {
    throw new Error(`Invalid SSH workspace URI: ${input}`);
  }
  if (uri.password.length > 0) throw new Error("SSH workspace URI must not contain a password");
  if (uri.search.length > 0 || uri.hash.length > 0) {
    throw new Error("SSH workspace URI must not contain a query or fragment");
  }
  return uri;
}

function decoded(value: string, input: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(`Invalid SSH workspace URI: ${input}`);
  }
}

function normalizedHost(uri: URL): string {
  return uri.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function sshUriRemotePath(binding: WorkspaceBinding, uri: URL, input: string): string {
  if (binding.target.scheme !== "ssh") {
    throw new Error(`Termia has no active SSH workspace for ${input}`);
  }
  const active = new URL(workspaceUri(binding.target));
  const requestedUser = decoded(uri.username, input);
  const activeUser = decoded(active.username, workspaceUri(binding.target));
  const requestedPort = uri.port || "22";
  const activePort = active.port || "22";
  if (
    requestedUser !== activeUser
    || normalizedHost(uri) !== normalizedHost(active)
    || requestedPort !== activePort
  ) {
    throw new Error(
      `Requested SSH workspace ${requestedUser}@${uri.host} does not match active SSH workspace ${activeUser}@${active.host}`,
    );
  }
  const path = decoded(uri.pathname || "/", input);
  if (path.includes("\0")) throw new Error("Workspace path cannot contain NUL bytes");
  return posix.resolve("/", path);
}

export function projectWorkspacePath(binding: WorkspaceBinding, input: string): string {
  if (input.includes("\0")) throw new Error("Workspace path cannot contain NUL bytes");
  const uri = parseSshUri(input);
  if (uri !== undefined) {
    if (binding.target.scheme !== "ssh") {
      throw new Error(`Termia has no active SSH workspace for ${input}`);
    }
    if (binding.mountRoot === undefined) throw new Error("Termia SSH workspace has no mount root");
    return resolve(binding.mountRoot, `.${sshUriRemotePath(binding, uri, input)}`);
  }
  if (binding.target.scheme !== "ssh") return input;
  if (binding.mountRoot === undefined) throw new Error("Termia SSH workspace has no mount root");
  if (isAbsolute(input)) return input;
  const location = relative(binding.mountRoot, resolve(binding.piCwd, input));
  if (location !== ".." && !location.startsWith(`..${sep}`) && !isAbsolute(location)) return input;
  return resolve(binding.mountRoot, `.${posix.resolve(binding.target.path, input)}`);
}

export function presentWorkspaceCwd(
  prompt: string,
  binding: WorkspaceBinding,
  skills: readonly { filePath: string }[] = [],
): string {
  if (binding.target.scheme !== "ssh") return prompt;
  if (binding.mountRoot === undefined) throw new Error("Termia SSH workspace has no mount root");
  let presented = prompt;
  for (const skill of skills) {
    const location = relative(binding.mountRoot, resolve(skill.filePath));
    if (location === ".." || location.startsWith(`..${sep}`) || isAbsolute(location)) continue;
    const uri = new URL(workspaceUri(binding.target));
    uri.pathname = `/${location.split(sep).join("/")}`;
    presented = presented.replaceAll(skill.filePath, uri.href);
  }
  const physicalCwd = binding.piCwd.replaceAll("\\", "/");
  return presented.replace(
    `Current working directory: ${physicalCwd}`,
    `${SSH_PATH_GUIDANCE}\nCurrent working directory: ${workspaceUri(binding.target)}`,
  );
}
