import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { HistoryStore } from "../extensions/termia/history.ts";
import {
  createModeBashOperations,
  createPtyBashOperations,
} from "../extensions/termia/pty-bash.ts";
import { TerminalController } from "../extensions/termia/terminal.ts";

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

test("isolates ordinary Pi bash while recording Termia history", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "termia-ordinary-bash-"));
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

  const operations = createPtyBashOperations(terminal, true);
  const firstCommand = `export TERMIA_ORDINARY_VALUE=leaked\ncd ${target}\nprintf '%s:%s\\n' "$TERMIA_ORDINARY_VALUE" "$PWD"`;
  const secondCommand = `printf '%s:%s\\n' "\${TERMIA_ORDINARY_VALUE-unset}" "$PWD"`;
  const firstResult = await operations.exec(firstCommand, cwd, { onData: () => {} });
  const output: Buffer[] = [];
  const secondResult = await operations.exec(secondCommand, cwd, {
    onData: (data) => output.push(data),
  });

  assert.equal(firstResult.exitCode, 0);
  assert.equal(secondResult.exitCode, 0);
  assert.match(Buffer.concat(output).toString(), new RegExp(`unset:${cwd}`));
  assert.equal(terminal.cwd, cwd);
  const recorded = history.listCompletedCommands(10).map((command) => command.command);
  assert.equal(recorded.includes(firstCommand), true);
  assert.equal(recorded.includes(secondCommand), true);
});

test("uses Pi local bash while disabled and isolated Termia PTY commands while enabled", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "termia-mode-bash-"));
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
  let enabled = false;
  const operations = createModeBashOperations(
    () => enabled,
    createLocalBashOperations(),
    terminal,
  );
  const output: Buffer[] = [];

  const local = await operations.exec("printf local", cwd, {
    onData: (data) => output.push(data),
  });

  assert.equal(local.exitCode, 0);
  assert.equal(Buffer.concat(output).toString(), "local");
  assert.equal(terminal.running, false);
  assert.deepEqual(history.listCompletedCommands(10), []);

  enabled = true;
  await operations.exec(
    `export TERMIA_MODE_VALUE=ordinary\ncd ${target}`,
    cwd,
    { onData: () => {} },
  );
  const isolatedOutput: Buffer[] = [];
  const isolated = await operations.exec(
    `printf '%s:%s' "\${TERMIA_MODE_VALUE-unset}" "$PWD"`,
    cwd,
    { onData: (data) => isolatedOutput.push(data) },
  );

  assert.equal(isolated.exitCode, 0);
  assert.equal(Buffer.concat(isolatedOutput).toString(), `unset:${cwd}`);
  assert.equal(terminal.running, true);

  await operations.exec(
    `export TERMIA_MODE_VALUE=quick\ncd ${target}`,
    cwd,
    { onData: () => {} },
  );
  const quickOutput: Buffer[] = [];
  const quick = await operations.exec(
    `printf '%s:%s' "\${TERMIA_MODE_VALUE-unset}" "$PWD"`,
    cwd,
    { onData: (data) => quickOutput.push(data) },
  );

  assert.equal(quick.exitCode, 0);
  assert.equal(Buffer.concat(quickOutput).toString(), `unset:${cwd}`);
  assert.equal(history.listCompletedCommands(10).length, 4);
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
