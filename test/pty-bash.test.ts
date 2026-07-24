import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createLocalBashOperations,
  type BashOperations,
} from "@earendil-works/pi-coding-agent";
import { HistoryStore } from "../extensions/termia/history.ts";
import {
  createModeBashOperations,
  createPtyBashOperations,
} from "../extensions/termia/pty-bash.ts";
import { TerminalController } from "../extensions/termia/terminal.ts";
import { sshWorkspace, type SshHop } from "../extensions/termia/workspace.ts";

test("adapts Pi bash operations to the persistent Termia shell", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "termia-pty-bash-"));
  const cwd = join(root, "cwd");
  const target = join(cwd, "target");
  mkdirSync(target, { recursive: true });
  const history = new HistoryStore(join(root, "state"));
  const terminal = new TerminalController(history);
  t.after(() => {
    terminal.dispose();
    history.close();
    rmSync(root, { recursive: true, force: true });
  });

  const operations = createPtyBashOperations(terminal);

  await operations.exec("export TERMIA_AGENT_VALUE=agent", cwd, { onData: () => {} });
  const chunks: Buffer[] = [];
  const printed = await operations.exec(
    `cd ${target}\nprintf '%s:%s\\n' "$TERMIA_AGENT_VALUE" "$PWD"`,
    cwd,
    { onData: (data) => chunks.push(data) },
  );
  assert.equal(printed.exitCode, 0);
  assert.match(Buffer.concat(chunks).toString(), new RegExp(`agent:${target}`));
  assert.equal(terminal.cwd, target);

  const failed = await operations.exec("false", cwd, { onData: () => {} });
  assert.equal(failed.exitCode, 1);

  const abortController = new AbortController();
  const aborted = operations.exec("sleep 10", cwd, {
    onData: () => {},
    signal: abortController.signal,
  });
  setTimeout(() => abortController.abort(), 100);
  await assert.rejects(aborted, /^Error: aborted$/);

  await assert.rejects(
    operations.exec("sleep 10", cwd, { onData: () => {}, timeout: 0.1 }),
    /^Error: timeout:0.1$/,
  );
});

test("uses Pi detached Bash with ignored stdin while Termia is enabled locally", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "termia-mode-bash-"));
  const cwd = join(root, "cwd");
  mkdirSync(cwd, { recursive: true });
  const history = new HistoryStore(join(root, "state"));
  const terminal = new TerminalController(history);
  t.after(() => {
    terminal.dispose();
    history.close();
    rmSync(root, { recursive: true, force: true });
  });
  const operations = createModeBashOperations(
    () => true,
    createLocalBashOperations(),
    terminal,
  );
  const output: Buffer[] = [];

  const local = await operations.exec(
    "if [ -t 0 ]; then echo tty; else echo no-tty; fi; if (exec 3</dev/tty) 2>/dev/null; then echo controlling-tty; else echo no-controlling-tty; fi; IFS= read -r value || echo eof",
    cwd,
    {
      onData: (data) => output.push(data),
    },
  );

  assert.equal(local.exitCode, 0);
  assert.equal(Buffer.concat(output).toString(), "no-tty\nno-controlling-tty\neof\n");
  assert.equal(terminal.running, false);
  assert.deepEqual(history.listCompletedCommands(10), []);
});

test("routes SSH Bash through the detached local backend", async () => {
  const hops: SshHop[] = [{
    shellId: "remote",
    parentShellId: "local",
    destination: "server",
    user: "klein",
    host: "192.168.100.3",
    port: 22,
    controlPath: "/tmp/termia-ssh/control",
  }];
  const binding = sshWorkspace(hops, "/srv/app", "/tmp/termia-mount");
  let delegated: { command: string; cwd: string; timeout: number | undefined } | undefined;
  const local: BashOperations = {
    exec: async (command, cwd, options) => {
      delegated = { command, cwd, timeout: options.timeout };
      options.onData(Buffer.from("remote-output"));
      return { exitCode: 7 };
    },
  };
  const terminal = {
    workspace: binding,
    assertWorkspace: (cwd: string) => assert.equal(cwd, binding.piCwd),
  } as unknown as TerminalController;
  const output: Buffer[] = [];

  const result = await createModeBashOperations(() => true, local, terminal).exec(
    "printf 'hello'\nread value",
    binding.piCwd,
    { onData: (data) => output.push(data), timeout: 12 },
  );

  assert.equal(result.exitCode, 7);
  assert.equal(Buffer.concat(output).toString(), "remote-output");
  assert.equal(delegated?.cwd, binding.piCwd);
  assert.equal(delegated?.timeout, 12);
  assert.match(delegated?.command ?? "", /ssh -T -S/);
  assert.match(delegated?.command ?? "", /\/srv\/app/);
  assert.doesNotMatch(delegated?.command ?? "", /read value/);
});

test("aborts only the selected concurrent Agent Bash job", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "termia-agent-abort-"));
  const cwd = join(root, "cwd");
  mkdirSync(cwd);
  const history = new HistoryStore(join(root, "state"));
  const terminal = new TerminalController(history);
  t.after(() => {
    terminal.dispose();
    history.close();
    rmSync(root, { recursive: true, force: true });
  });
  const operations = createModeBashOperations(() => true, createLocalBashOperations(), terminal);
  const abort = new AbortController();
  const killedOutput: Buffer[] = [];
  const survivorOutput: Buffer[] = [];
  const killed = operations.exec("printf killed-start; sleep 30", cwd, {
    onData: (data) => killedOutput.push(data),
    signal: abort.signal,
  });
  const survivor = operations.exec("printf survivor; sleep 0.2; printf done", cwd, {
    onData: (data) => survivorOutput.push(data),
  }).then(
    (value) => ({ value }),
    (error: Error) => ({ error }),
  );
  setTimeout(() => abort.abort(), 100);

  await assert.rejects(killed, /^Error: aborted$/);
  const survivorResult = await survivor;
  assert.ok(
    "value" in survivorResult,
    "error" in survivorResult ? survivorResult.error.message : undefined,
  );
  assert.equal(survivorResult.value?.exitCode, 0);
  assert.equal(Buffer.concat(survivorOutput).toString(), "survivordone");
  assert.equal(history.listCompletedCommands(10).length, 0);
});

test("times out only the selected Agent Bash job", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "termia-agent-timeout-"));
  const cwd = join(root, "cwd");
  mkdirSync(cwd);
  const history = new HistoryStore(join(root, "state"));
  const terminal = new TerminalController(history);
  t.after(() => {
    terminal.dispose();
    history.close();
    rmSync(root, { recursive: true, force: true });
  });
  const operations = createModeBashOperations(() => true, createLocalBashOperations(), terminal);

  await assert.rejects(
    operations.exec("trap '' INT; sleep 30", cwd, { onData: () => {}, timeout: 0.1 }),
    /^Error: timeout:0.1$/,
  );
  const output: Buffer[] = [];
  const result = await operations.exec("printf after-timeout", cwd, {
    onData: (data) => output.push(data),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(Buffer.concat(output).toString(), "after-timeout");
  assert.equal(history.listCompletedCommands(10).length, 0);
});

test("checks the requested workspace before writing to the PTY", async () => {
  let writes = 0;
  const terminal = {
    running: true,
    assertWorkspace: (cwd: string) => {
      assert.equal(cwd, "/stale/mount");
      throw new Error("Termia SSH workspace is disconnected");
    },
    execute: async () => {
      writes += 1;
      throw new Error("must not execute");
    },
  } as unknown as TerminalController;

  await assert.rejects(
    createPtyBashOperations(terminal).exec("pwd", "/stale/mount", { onData: () => {} }),
    /SSH workspace is disconnected/,
  );
  assert.equal(writes, 0);
});
