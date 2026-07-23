import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { HistoryStore } from "../extensions/termia/history.ts";
import { TerminalController } from "../extensions/termia/terminal.ts";
import { workspaceUri, type WorkspaceBinding } from "../extensions/termia/workspace.ts";

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

async function waitFor<T>(description: string, read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function waitForHost(controller: TerminalController, destination: string): Promise<WorkspaceBinding> {
  return waitFor(`SSH workspace ${destination}`, () => {
    const binding = controller.workspace;
    if (binding.target.scheme !== "ssh") return undefined;
    return binding.target.hops.at(-1)?.destination === destination ? binding : undefined;
  });
}

async function waitForLocal(controller: TerminalController): Promise<WorkspaceBinding> {
  return waitFor("local workspace", () => {
    const binding = controller.workspace;
    return binding.target.scheme === "file" ? binding : undefined;
  });
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
  const controller = new TerminalController(history);
  t.after(() => {
    controller.dispose();
    history.close();
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousConfig === undefined) delete process.env.TERMIA_TEST_SSH_CONFIG;
    else process.env.TERMIA_TEST_SSH_CONFIG = previousConfig;
    rmSync(root, { recursive: true, force: true });
  });

  controller.start(localCwd, "/bin/bash");
  await controller.execute("true");
  controller.write("ssh host-a\r");
  await waitForHost(controller, "host-a");
  await controller.execute("cd /workspace");
  const bindingA = await waitForHost(controller, "host-a");
  assert.equal(readFileSync(join(bindingA.mountRoot!, "workspace/a.txt"), "utf8").trim(), "host-a");
  await controller.execute("printf 'agent-a\\n'");

  controller.write("ssh host-b\r");
  await waitForHost(controller, "host-b");
  await controller.execute("cd /workspace");
  const bindingB = await waitForHost(controller, "host-b");
  assert.equal(readFileSync(join(bindingB.mountRoot!, "workspace/b.txt"), "utf8").trim(), "host-b");
  await controller.execute("printf 'agent-b\\n'");

  controller.write("ssh host-c\r");
  await waitForHost(controller, "host-c");
  await controller.execute("cd /workspace");
  const bindingC = await waitForHost(controller, "host-c");
  assert.equal(workspaceUri(bindingC.target), "ssh://termia@host-c/workspace");
  assert.equal(readFileSync(join(bindingC.mountRoot!, "workspace/c.txt"), "utf8").trim(), "host-c");

  await controller.execute([
    "TERMIA_C_PRIVATE=private-c",
    "termia_c_function() { printf 'function:%s\\n' \"$TERMIA_C_PRIVATE\"; }",
  ].join("; "));
  const firstReady = "/tmp/termia-agent-c-first.ready";
  const secondReady = "/tmp/termia-agent-c-second.ready";
  const gate = "/tmp/termia-agent-c.go";
  await controller.execute(`rm -f ${firstReady} ${secondReady} ${gate}`);
  const historyBeforeAgents = history.listCompletedCommands(200).length;
  const firstCommand = `: >${firstReady}; while [ ! -f ${gate} ]; do sleep 0.02; done; printf 'first:%s:%s\\n' "$TERMIA_C_PRIVATE" "$PWD"; termia_c_function; cd /`;
  const secondCommand = `: >${secondReady}; while [ ! -f ${gate} ]; do sleep 0.02; done; printf 'second:%s:%s\\n' "$TERMIA_C_PRIVATE" "$PWD"; termia_c_function`;
  const firstOutput: Buffer[] = [];
  const secondOutput: Buffer[] = [];
  const firstAgent = controller.executeAgent(firstCommand, { onOutput: (data) => firstOutput.push(data) });
  const secondAgent = controller.executeAgent(secondCommand, { onOutput: (data) => secondOutput.push(data) });
  const mountedFirstReady = join(bindingC.mountRoot!, firstReady);
  const mountedSecondReady = join(bindingC.mountRoot!, secondReady);
  await waitFor("concurrent Agent jobs on host-c", () =>
    existsSync(mountedFirstReady) && existsSync(mountedSecondReady) ? true : undefined);
  writeFileSync(join(bindingC.mountRoot!, gate), "go");
  assert.deepEqual(await Promise.all([firstAgent, secondAgent]), [{ exitCode: 0 }, { exitCode: 0 }]);
  assert.match(Buffer.concat(firstOutput).toString(), /first:private-c:\/workspace/);
  assert.match(Buffer.concat(firstOutput).toString(), /function:private-c/);
  assert.match(Buffer.concat(secondOutput).toString(), /second:private-c:\/workspace/);
  assert.match(Buffer.concat(secondOutput).toString(), /function:private-c/);
  assert.equal(controller.cwd, "/workspace");
  assert.equal(history.listCompletedCommands(200).length, historyBeforeAgents);

  const stdinDescriptors = {
    isTTY: Object.getOwnPropertyDescriptor(process.stdin, "isTTY"),
    isRaw: Object.getOwnPropertyDescriptor(process.stdin, "isRaw"),
    setRawMode: Object.getOwnPropertyDescriptor(process.stdin, "setRawMode"),
  };
  const stdoutDescriptors = {
    isTTY: Object.getOwnPropertyDescriptor(process.stdout, "isTTY"),
    write: Object.getOwnPropertyDescriptor(process.stdout, "write"),
  };
  const restore = (target: object, key: string, descriptor: PropertyDescriptor | undefined) => {
    if (descriptor === undefined) Reflect.deleteProperty(target, key);
    else Object.defineProperty(target, key, descriptor);
  };
  Object.defineProperties(process.stdin, {
    isTTY: { configurable: true, value: true },
    isRaw: { configurable: true, writable: true, value: false },
    setRawMode: {
      configurable: true,
      value: (raw: boolean) => Reflect.set(process.stdin, "isRaw", raw),
    },
  });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  const screen: string[] = [];
  Object.defineProperty(process.stdout, "write", {
    configurable: true,
    value: (chunk: string | Uint8Array): boolean => {
      screen.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    },
  });
  let starts = 0;
  let stops = 0;
  controller.setUi({
    custom: (factory: (...args: unknown[]) => unknown) => new Promise((resolve) => {
      factory({
        start: () => starts += 1,
        stop: () => stops += 1,
        requestRender: () => {},
      }, undefined, undefined, resolve);
      setTimeout(() => process.stdin.emit("data", Buffer.from("alpha\rbeta\r")), 50);
    }),
  } as Parameters<TerminalController["setUi"]>[0]);
  const interactiveOutput: Buffer[] = [];
  const interactiveCommand = [
    "printf 'remote:first?\\n'",
    "read -r first",
    "printf 'remote:second?\\n'",
    "read -r second",
    "printf 'remote:%s:%s\\n' \"$first\" \"$second\"",
  ].join("; ");
  try {
    const interactive = await controller.executeAgent(interactiveCommand, {
      signal: AbortSignal.timeout(10_000),
      onOutput: (data) => interactiveOutput.push(data),
    });
    assert.equal(interactive.exitCode, 0);
  } finally {
    controller.setUi(undefined);
    process.stdin.pause();
    restore(process.stdin, "isTTY", stdinDescriptors.isTTY);
    restore(process.stdin, "isRaw", stdinDescriptors.isRaw);
    restore(process.stdin, "setRawMode", stdinDescriptors.setRawMode);
    restore(process.stdout, "isTTY", stdoutDescriptors.isTTY);
    restore(process.stdout, "write", stdoutDescriptors.write);
  }
  assert.match(Buffer.concat(interactiveOutput).toString(), /remote:alpha:beta/);
  assert.match(screen.join(""), /remote:first\?/);
  assert.equal(starts, 1);
  assert.equal(stops, 1);
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
    /first:private-c|second:private-c|remote:first\?|remote:alpha:beta/,
  );

  compose(["stop", "host-c"]);
  await waitFor("host-c disconnect", () => controller.isWorkspaceHealthy(bindingC) ? undefined : true);
  await waitForShellReady(controller, bindingB.target.scheme === "ssh" ? bindingB.target.hops.at(-1)!.shellId : "");
  await waitForHost(controller, "host-b");
  controller.write("exit\r");
  await waitForShellReady(controller, bindingA.target.scheme === "ssh" ? bindingA.target.hops.at(-1)!.shellId : "");
  await waitForHost(controller, "host-a");

  compose(["exec", "-T", "host-b", "touch", "/tmp/termia-disable-sftp"]);
  const parentShellId = bindingA.target.scheme === "ssh" ? bindingA.target.hops.at(-1)!.shellId : "";
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
  await assert.rejects(() => controller.readyWorkspace(withoutSftp.shellId), /SSH workspace unavailable/);
  assert.equal(workspaceUri(controller.workspace.target), workspaceUri(bindingA.target));
  controller.write("exit\r");
  await waitForShellReady(controller, parentShellId);
  await waitForHost(controller, "host-a");
  const rootShellId = bindingA.target.scheme === "ssh" ? bindingA.target.hops[0]!.parentShellId : "";
  controller.write("exit\r");
  await waitForShellReady(controller, rootShellId);
  await waitForLocal(controller);

  const records = history.listCompletedCommands(200);
  assert.ok(records.some((record) => record.hopChain.at(-1) === "host-a"));
  assert.ok(records.some((record) => record.hopChain.at(-1) === "host-b"));
  assert.ok(records.some((record) => record.hopChain.at(-1) === "host-c"));
  assert.equal(records.some((record) => record.command.startsWith("ssh host-")), false);
});
