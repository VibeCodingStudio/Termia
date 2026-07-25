import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import {
  createActiveWorkspace,
  type ActiveWorkspace,
  type TerminalWorkspaceFeed,
  type WorkspaceAccess,
} from "../extensions/termia/active-workspace.ts";
import { HistoryStore } from "../extensions/termia/history.ts";
import { TerminalController } from "../extensions/termia/terminal.ts";

const enabled = process.env.TERMIA_SSH_INTEGRATION === "1";
const fixture = join(dirname(fileURLToPath(import.meta.url)), "integration/ssh");
const composeFile = join(fixture, "compose.yml");

function requireCommand(command: string): void {
  const result = spawnSync("sh", ["-c", 'command -v "$1" >/dev/null', "sh", command]);
  if (result.status !== 0) {
    throw new Error(`Termia SSH integration requires '${command}' on PATH`);
  }
}

function compose(args: string[], capture = false): string {
  return execFileSync("docker", ["compose", "-f", composeFile, ...args], {
    cwd: fixture,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    timeout: 120_000,
  }) ?? "";
}

async function waitFor<T>(
  description: string,
  read: () => T | undefined | Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

type WorkspaceHarness = {
  controller: TerminalController;
  workspace: ActiveWorkspace;
  terminalFeed: TerminalWorkspaceFeed;
};

type LocatedWorkspace = {
  access: WorkspaceAccess;
  shellId: string;
};

function activeShellId(controller: TerminalController): string {
  return Reflect.get(controller, "activeShellId") as string;
}

async function activateShell(
  harness: WorkspaceHarness,
  shellId: string,
): Promise<WorkspaceAccess | undefined> {
  const activation = await harness.workspace.prepare(shellId);
  if (activation.kind === "pending") return undefined;
  if (activation.kind === "ready") activation.commit();
  return harness.workspace.current();
}

async function waitForHost(
  harness: WorkspaceHarness,
  destination: string,
): Promise<LocatedWorkspace> {
  return waitFor(`SSH workspace ${destination}`, () => {
    const shellId = activeShellId(harness.controller);
    let context;
    try {
      context = harness.terminalFeed.contextFor(shellId);
    } catch {
      return undefined;
    }
    if (context.hopChain.at(-1) !== destination) return undefined;
    return activateShell(harness, shellId).then((access) =>
      access === undefined ? undefined : { access, shellId });
  });
}

async function waitForIdentity(
  harness: WorkspaceHarness,
  user: string,
): Promise<LocatedWorkspace> {
  return waitFor(`${user} identity workspace`, () => {
    const shellId = activeShellId(harness.controller);
    let context;
    try {
      context = harness.terminalFeed.contextFor(shellId);
    } catch {
      return undefined;
    }
    const leaf = context.hopChain.at(-1);
    if (new URL(context.workspaceUri).username !== user || !leaf?.includes("@termia-identity-")) {
      return undefined;
    }
    return activateShell(harness, shellId).then((access) =>
      access === undefined ? undefined : { access, shellId });
  });
}

async function concurrentAgentUsers(
  access: WorkspaceAccess,
): Promise<string[]> {
  const output = [[], []] as Buffer[][];
  const results = await Promise.all(output.map((chunks) => access.runDetached({
    command: "id -un",
    cwd: access.executionDirectory(),
    options: { onData: (data) => chunks.push(data), timeout: 10 },
  })));
  assert.deepEqual(results, [{ exitCode: 0 }, { exitCode: 0 }]);
  return output.map((chunks) => Buffer.concat(chunks).toString().trim());
}

async function waitForLocal(harness: WorkspaceHarness): Promise<LocatedWorkspace> {
  return waitFor("local workspace", () => {
    const shellId = activeShellId(harness.controller);
    let context;
    try {
      context = harness.terminalFeed.contextFor(shellId);
    } catch {
      return undefined;
    }
    if (context.hopChain.length !== 0) return undefined;
    return activateShell(harness, shellId).then((access) =>
      access === undefined ? undefined : { access, shellId });
  });
}

function remotePath(access: WorkspaceAccess, path: string): string {
  const uri = new URL(access.summary.uri);
  uri.pathname = path;
  return access.filePath(uri.href);
}

async function waitForShellReady(controller: TerminalController, shellId: string): Promise<void> {
  await waitFor(`shell ${shellId}`, () =>
    Reflect.get(controller, "activeShellId") === shellId
      && Reflect.get(controller, "shellReady") === true
      ? true
      : undefined);
}

test("runs a credential-isolated local -> A -> B -> C workspace chain", { skip: !enabled }, async (t) => {
  for (const command of ["docker", "ssh", "sshfs", "fusermount3"]) requireCommand(command);

  compose(["down", "--volumes", "--remove-orphans"]);
  compose(["up", "-d", "--build"]);
  t.after(() => {
    try {
      compose(["down", "--volumes", "--remove-orphans"]);
    } finally {
      rmSync(join(fixture, "generated/local"), { force: true });
      rmSync(join(fixture, "generated/local.pub"), { force: true });
    }
  });

  const portOutput = compose(["port", "host-a", "22"], true).trim();
  const port = Number(portOutput.slice(portOutput.lastIndexOf(":") + 1));
  assert.ok(Number.isSafeInteger(port) && port > 0, `invalid host-a port: ${portOutput}`);

  const root = mkdtempSync(join(tmpdir(), "termia-ssh-integration-"));
  const localCwd = join(root, "workspace");
  const stateRoot = join(root, "state");
  const config = join(root, "ssh-config");
  const wrapper = join(root, "ssh");
  mkdirSync(localCwd);
  writeFileSync(config, [
    "Host host-a",
    "  HostName 127.0.0.1",
    `  Port ${port}`,
    "  User termia",
    `  IdentityFile ${join(fixture, "generated/local")}`,
    "  IdentitiesOnly yes",
    "  StrictHostKeyChecking no",
    "  UserKnownHostsFile /dev/null",
    "  LogLevel ERROR",
    "",
  ].join("\n"));
  writeFileSync(wrapper, "#!/bin/sh\nexec /usr/bin/ssh -F \"$TERMIA_TEST_SSH_CONFIG\" \"$@\"\n");
  chmodSync(wrapper, 0o700);

  await waitFor("host-a sshd", () => {
    const result = spawnSync("/usr/bin/ssh", ["-F", config, "host-a", "true"]);
    return result.status === 0 ? true : undefined;
  });
  const hostBPort = spawnSync("docker", ["compose", "-f", composeFile, "port", "host-b", "22"], {
    cwd: fixture,
    encoding: "utf8",
  });
  assert.equal(hostBPort.stdout.trim(), "");
  assert.notEqual(
    spawnSync("docker", ["compose", "-f", composeFile, "exec", "-T", "host-a", "runuser", "-u", "termia", "--", "ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "host-c", "true"]).status,
    0,
  );

  const previousPath = process.env.PATH;
  const previousConfig = process.env.TERMIA_TEST_SSH_CONFIG;
  process.env.PATH = `${root}:${previousPath ?? ""}`;
  process.env.TERMIA_TEST_SSH_CONFIG = config;
  const history = new HistoryStore(stateRoot);
  const localBash = createLocalBashOperations();
  const facets = createActiveWorkspace(localCwd, {
    run: ({ command, cwd, options }) => localBash.exec(command, cwd, options),
  });
  const controller = new TerminalController(history, facets.terminal);
  const harness: WorkspaceHarness = {
    controller,
    workspace: facets.workspace,
    terminalFeed: facets.terminal,
  };
  t.after(async () => {
    controller.dispose();
    await facets.workspace[Symbol.asyncDispose]();
    history.close();
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousConfig === undefined) delete process.env.TERMIA_TEST_SSH_CONFIG;
    else process.env.TERMIA_TEST_SSH_CONFIG = previousConfig;
    rmSync(root, { recursive: true, force: true });
  });

  controller.start(localCwd, "/bin/bash");
  await controller.execute("true");
  const rootShellId = activeShellId(controller);
  controller.write("ssh host-a\r");
  await waitForHost(harness, "host-a");
  await controller.execute("cd /workspace");
  const bindingA = await waitForHost(harness, "host-a");
  assert.equal(readFileSync(remotePath(bindingA.access, "/workspace/a.txt"), "utf8").trim(), "host-a");
  await controller.execute("printf 'agent-a\\n'");

  controller.write("sudo -i\r");
  const bindingRootA = await waitForIdentity(harness, "root");
  await controller.execute("cd /root");
  const rootA = await waitForIdentity(harness, "root");
  assert.equal(new URL(rootA.access.summary.uri).hostname, new URL(bindingA.access.summary.uri).hostname);
  assert.equal(new URL(rootA.access.summary.uri).port, new URL(bindingA.access.summary.uri).port);
  assert.equal(readFileSync(remotePath(rootA.access, "/root/root-only.txt"), "utf8").trim(), "root-only");
  assert.deepEqual(await concurrentAgentUsers(rootA.access), ["root", "root"]);
  assert.equal(controller.cwd, "/root");
  const manualRoot = await controller.execute("id -un");
  assert.equal(history.readOutput(manualRoot).trim(), "root");
  assert.equal(new URL(manualRoot.workspaceUri).username, "root");

  controller.write("ssh host-b\r");
  const bindingBFromRoot = await waitForHost(harness, "host-b");
  controller.write("sudo -u app -i\r");
  const bindingAppB = await waitForIdentity(harness, "app");
  assert.equal(readFileSync(remotePath(bindingAppB.access, "/home/app/app-only.txt"), "utf8").trim(), "app-only");
  assert.deepEqual(await concurrentAgentUsers(bindingAppB.access), ["app", "app"]);
  await controller.execute("cd /home/app");
  const manualApp = await controller.execute("id -un");
  assert.equal(history.readOutput(manualApp).trim(), "app");
  assert.equal(manualApp.workspaceUri, "ssh://app@host-b/home/app");

  const appShellId = bindingAppB.shellId;
  const hostBShellId = bindingBFromRoot.shellId;
  const rootAShellId = bindingRootA.shellId;
  controller.write("exit\r");
  await waitForShellReady(controller, hostBShellId);
  assert.equal((await waitForHost(harness, "host-b")).access.summary.uri, bindingBFromRoot.access.summary.uri);
  controller.write("exit\r");
  await waitForShellReady(controller, rootAShellId);
  assert.equal(new URL((await waitForIdentity(harness, "root")).access.summary.uri).username, "root");
  controller.write("exit\r");
  await waitForShellReady(controller, bindingA.shellId);
  assert.equal((await waitForHost(harness, "host-a")).access.summary.uri, bindingA.access.summary.uri);
  assert.notEqual(appShellId, hostBShellId);

  controller.write("ssh host-b\r");
  await waitForHost(harness, "host-b");
  await controller.execute("cd /workspace");
  const bindingB = await waitForHost(harness, "host-b");
  assert.equal(readFileSync(remotePath(bindingB.access, "/workspace/b.txt"), "utf8").trim(), "host-b");
  await controller.execute("printf 'agent-b\\n'");

  controller.write("ssh host-c\r");
  await waitForHost(harness, "host-c");
  await controller.execute("cd /workspace");
  const bindingC = await waitForHost(harness, "host-c");
  assert.equal(bindingC.access.summary.uri, "ssh://termia@host-c/workspace");
  assert.equal(readFileSync(remotePath(bindingC.access, "/workspace/c.txt"), "utf8").trim(), "host-c");

  await controller.execute([
    "TERMIA_C_PRIVATE=private-c",
    "termia_c_function() { printf 'function:%s\\n' \"$TERMIA_C_PRIVATE\"; }",
  ].join("; "));
  const firstReady = "/tmp/termia-agent-c-first.ready";
  const secondReady = "/tmp/termia-agent-c-second.ready";
  const gate = "/tmp/termia-agent-c.go";
  await controller.execute(`rm -f ${firstReady} ${secondReady} ${gate}`);
  const historyBeforeAgents = history.listCompletedCommands(200).length;
  const firstCommand = `: >${firstReady}; while [ ! -f ${gate} ]; do sleep 0.02; done; printf 'first:%s:%s\\n' "\${TERMIA_C_PRIVATE-unset}" "$PWD"; cd /`;
  const secondCommand = `: >${secondReady}; while [ ! -f ${gate} ]; do sleep 0.02; done; printf 'second:%s:%s\\n' "\${TERMIA_C_PRIVATE-unset}" "$PWD"`;
  const firstOutput: Buffer[] = [];
  const secondOutput: Buffer[] = [];
  const firstAgent = bindingC.access.runDetached({
    command: firstCommand,
    cwd: bindingC.access.executionDirectory(),
    options: { onData: (data) => firstOutput.push(data), timeout: 10 },
  });
  const secondAgent = bindingC.access.runDetached({
    command: secondCommand,
    cwd: bindingC.access.executionDirectory(),
    options: { onData: (data) => secondOutput.push(data), timeout: 10 },
  });
  const mountedFirstReady = remotePath(bindingC.access, firstReady);
  const mountedSecondReady = remotePath(bindingC.access, secondReady);
  await waitFor("concurrent Agent jobs on host-c", () =>
    existsSync(mountedFirstReady) && existsSync(mountedSecondReady) ? true : undefined);
  writeFileSync(remotePath(bindingC.access, gate), "go");
  assert.deepEqual(await Promise.all([firstAgent, secondAgent]), [{ exitCode: 0 }, { exitCode: 0 }]);
  assert.match(Buffer.concat(firstOutput).toString(), /first:unset:\/workspace/);
  assert.match(Buffer.concat(secondOutput).toString(), /second:unset:\/workspace/);
  assert.equal(controller.cwd, "/workspace");
  assert.equal(history.listCompletedCommands(200).length, historyBeforeAgents);

  const interactiveOutput: Buffer[] = [];
  const interactiveCommand = "test ! -t 0 && ! IFS= read -r value && printf 'remote:eof\\n'";
  assert.deepEqual(await bindingC.access.runDetached({
    command: interactiveCommand,
    cwd: bindingC.access.executionDirectory(),
    options: { onData: (data) => interactiveOutput.push(data), timeout: 10 },
  }), { exitCode: 0 });
  assert.equal(Buffer.concat(interactiveOutput).toString(), "remote:eof\n");
  assert.equal(history.listCompletedCommands(200).length, historyBeforeAgents);

  const manualC = await controller.execute("printf 'manual-c:%s\\n' \"$PWD\"");
  assert.match(history.readOutput(manualC), /manual-c:\/workspace/);
  assert.equal(manualC.workspaceUri, "ssh://termia@host-c/workspace");
  const recordsAfterC = history.listCompletedCommands(200);
  assert.equal(recordsAfterC.some((record) =>
    record.command === firstCommand
    || record.command === secondCommand
    || record.command === interactiveCommand), false);
  assert.doesNotMatch(
    recordsAfterC.map((record) => history.readOutput(record)).join("\n"),
    /first:unset|second:unset|remote:eof/,
  );

  compose(["stop", "host-c"]);
  await waitFor("host-c disconnect", () =>
    harness.workspace.current().summary.availability.kind === "unavailable" ? true : undefined);
  await waitForShellReady(controller, bindingB.shellId);
  await waitForHost(harness, "host-b");
  controller.write("exit\r");
  await waitForShellReady(controller, bindingA.shellId);
  await waitForHost(harness, "host-a");

  compose(["exec", "-T", "host-b", "touch", "/tmp/termia-disable-sftp"]);
  const parentShellId = bindingA.shellId;
  controller.write("ssh host-b\r");
  const failedShellId = await waitFor("host-b shell without SFTP", () => {
    const shellId = Reflect.get(controller, "activeShellId");
    return Reflect.get(controller, "shellReady") === true
      && typeof shellId === "string"
      && shellId !== parentShellId
      ? shellId
      : undefined;
  });
  const withoutSftp = await controller.execute("printf 'host-b-without-sftp\\n'");
  assert.equal(withoutSftp.shellId, failedShellId);
  assert.match(history.readOutput(withoutSftp), /host-b-without-sftp/);
  const blocked = await harness.workspace.prepare(withoutSftp.shellId);
  assert.equal(blocked.kind, "pending");
  assert.match(blocked.kind === "pending" ? blocked.pending.reason ?? "" : "", /SSH workspace unavailable/);
  assert.equal(harness.workspace.current().summary.uri, bindingA.access.summary.uri);
  controller.write("exit\r");
  await waitForShellReady(controller, parentShellId);
  await waitForHost(harness, "host-a");
  controller.write("exit\r");
  await waitForShellReady(controller, rootShellId);
  await waitForLocal(harness);

  const records = history.listCompletedCommands(200);
  assert.ok(records.some((record) => record.hopChain.at(-1) === "host-a"));
  assert.ok(records.some((record) => record.hopChain.at(-1) === "host-b"));
  assert.ok(records.some((record) => record.hopChain.at(-1) === "host-c"));
  assert.equal(records.some((record) => record.command.startsWith("ssh host-")), false);
});
