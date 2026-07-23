import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { IPty } from "node-pty";
import { AgentJobSelector } from "../extensions/termia/agent-job-ui.ts";
import { HistoryStore, type CommandRecord } from "../extensions/termia/history.ts";
import type { SshOpenEvent } from "../extensions/termia/protocol.ts";
import type { MountOperations } from "../extensions/termia/ssh-workspace.ts";
import { isTermiaPty, TerminalController } from "../extensions/termia/terminal.ts";
import { sshWorkspace, workspaceUri, type SshHop, type WorkspaceBinding } from "../extensions/termia/workspace.ts";

const zsh = process.env.TERMIA_TEST_ZSH ?? (existsSync("/bin/zsh") ? "/bin/zsh" : undefined);
const ash = process.env.TERMIA_TEST_ASH;

function waitForCommand(controller: TerminalController, expected: string): Promise<CommandRecord> {
  return new Promise((resolveRecord, rejectRecord) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      rejectRecord(new Error(`Timed out waiting for command: ${expected}`));
    }, 3_000);
    const unsubscribe = controller.onCommand((record) => {
      if (record.command !== expected) return;
      clearTimeout(timeout);
      unsubscribe();
      resolveRecord(record);
    });
  });
}

async function waitForShellReady(controller: TerminalController): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (Reflect.get(controller, "shellReady") === true) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the Termia shell prompt");
}

function installFakePty(controller: TerminalController, explicit = false): string[] {
  const writes: string[] = [];
  const child = {
    write: (data: string) => writes.push(data),
    resize: () => {},
    kill: () => {},
    onData: () => ({ dispose: () => {} }),
    onExit: () => ({ dispose: () => {} }),
  } as unknown as IPty;
  const internals = controller as unknown as {
    pty: IPty;
    shellReady: boolean;
    explicitExecutionShells: Set<string>;
  };
  internals.pty = child;
  internals.shellReady = true;
  if (explicit) internals.explicitExecutionShells.add("local");
  return writes;
}

test("detects only the Termia PTY marker", () => {
  assert.equal(isTermiaPty("1"), true);
  assert.equal(isTermiaPty("0"), false);
  assert.equal(isTermiaPty(undefined), false);
});

test("chunks long explicit execution input below the ash line limit", async () => {
  const root = mkdtempSync(join(tmpdir(), "termia-terminal-chunks-"));
  const store = new HistoryStore(join(root, "state"));
  const controller = new TerminalController(store);
  const writes = installFakePty(controller, true);
  const command = `printf '%s' '${"x".repeat(600)}'`;
  const pending = controller.execute(command, { isolated: true });
  const settled = pending.catch(() => undefined);

  try {
    assert.ok(writes.length > 2);
    assert.ok(writes.every((line) => line.length <= 300));
    assert.equal(writes[0], "__termia_exec_stream\r");
    assert.equal(writes.at(-1), ".\r");
    const encoded = writes.slice(1, -1).map((line) => {
      const match = /^([A-Za-z0-9+/=]+)\r$/.exec(line);
      assert.ok(match);
      return match[1];
    }).join("");
    assert.equal(Buffer.from(encoded, "base64").toString("utf8"), `(${command})`);
  } finally {
    controller.dispose();
    await settled;
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("interrupts written commands before the shell start marker", async () => {
  const root = mkdtempSync(join(tmpdir(), "termia-terminal-prestart-"));
  const store = new HistoryStore(join(root, "state"));
  const controller = new TerminalController(store);
  const writes = installFakePty(controller);
  const abort = new AbortController();
  const pending = controller.execute("true", { signal: abort.signal });
  const settled = pending.catch(() => undefined);

  try {
    assert.equal(writes.length, 1);
    abort.abort();
    assert.equal(writes.at(-1), "\u0003");
  } finally {
    controller.dispose();
    await settled;
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

async function verifyPersistentShell(shell: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "termia-terminal-"));
  const cwd = join(root, "cwd");
  const target = join(cwd, "target");
  mkdirSync(target, { recursive: true });
  const store = new HistoryStore(join(root, "state"));
  const controller = new TerminalController(store);

  try {
    controller.start(cwd, shell);
    const exported = await controller.execute("export TERMIA_TEST_VALUE=kept");
    const output: string[] = [];
    const printed = await controller.execute(`printf '%s:%s\\n' "$TERMIA_TEST_VALUE" "$TERMIA_PTY"`, {
      onOutput: (data) => output.push(data),
    });
    const moved = await controller.execute(`cd ${target}`);

    assert.equal(exported.exitCode, 0);
    assert.match(store.readOutput(printed), /kept:1/);
    assert.match(output.join(""), /kept:1/);
    assert.equal(moved.cwd, cwd);
    assert.equal(controller.cwd, target);

    const sleeping = controller.execute("sleep 0.2");
    await assert.rejects(controller.execute("pwd"), /already running/);
    assert.equal((await sleeping).exitCode, 0);

    const abort = new AbortController();
    const startedAt = Date.now();
    const aborted = controller.execute("sleep 10", { signal: abort.signal });
    setTimeout(() => abort.abort(), 100);
    const abortedRecord = await aborted;
    assert.notEqual(abortedRecord.exitCode, 0);
    assert.ok(Date.now() - startedAt < 3_000);

    const multiline = await controller.execute("printf 'one\\n'\nprintf 'two\\n'");
    assert.equal(multiline.command, "printf 'one\\n'\nprintf 'two\\n'");
    assert.match(store.readOutput(multiline), /one[\s\S]*two/);

    await controller.restoreCwd(cwd);
    assert.equal(controller.cwd, cwd);
    await waitForShellReady(controller);

    const immediateAbort = new AbortController();
    const cancelled = controller.execute("sleep 10", { signal: immediateAbort.signal });
    immediateAbort.abort();
    const cancelledExit = await cancelled.then(
      (record) => record.exitCode,
      (error: Error) => {
        assert.match(error.message, /aborted before execution/);
        return 130;
      },
    );
    assert.notEqual(cancelledExit, 0);
    assert.equal((await controller.execute("true")).exitCode, 0);
    const functionCheck = await controller.execute("type termia");
    assert.match(store.readOutput(functionCheck), /termia is a (?:shell )?function/);

    let firstAgentCommandIndex = 0;
    let secondAgentCommandIndex = 0;
    const agentOutput: string[] = [];
    const quickRequest = new Promise<void>((resolveRequest, rejectRequest) => {
      const timeout = setTimeout(() => rejectRequest(new Error("Timed out waiting for quick ask")), 5_000);
      const unsubscribe = controller.onQuickAsk((request) => {
        unsubscribe();
        assert.match(request.shellId, /^[0-9a-f-]{36}$/);
        assert.equal(request.cwd, cwd);
        assert.deepEqual(request.argv, ["spaces here", "quotes: '\"", "你好", ""]);
        Reflect.set(controller, "attached", true);
        void (async () => {
          const first = await controller.execute("export TERMIA_AGENT_VALUE=agent", { isolated: true });
          const second = await controller.execute(
            `cd ${target}\nprintf 'hidden-tool-output:%s:%s\\n' "\${TERMIA_AGENT_VALUE-unset}" "$PWD"`,
            { isolated: true, onOutput: (data) => agentOutput.push(data) },
          );
          assert.equal(first.exitCode, 0);
          assert.equal(second.exitCode, 0);
          assert.match(store.readOutput(second), /hidden-tool-output:unset:/);
          assert.equal(controller.cwd, cwd);
          firstAgentCommandIndex = first.index;
          secondAgentCommandIndex = second.index;
          controller.completeQuickAsk(0, "quick answer\n");
        })().then(resolveRequest, rejectRequest).finally(() => clearTimeout(timeout));
      });
    });
    const quickCommand = "termia 'spaces here' \"quotes: '\\\"\" '你好' ''";
    const quickRecord = new Promise<CommandRecord>((resolveRecord) => {
      const unsubscribe = controller.onCommand((command) => {
        if (command.command !== quickCommand) return;
        unsubscribe();
        resolveRecord(command);
      });
    });
    const screenOutput: string[] = [];
    const stdoutWriteDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "write");
    Object.defineProperty(process.stdout, "write", {
      configurable: true,
      value: (chunk: string | Uint8Array): boolean => {
        screenOutput.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
        return true;
      },
    });
    try {
      controller.write(`\r${quickCommand}\r`);
      const [completedQuickRecord] = await Promise.all([quickRecord, quickRequest]);
      assert.equal(completedQuickRecord.exitCode, 0);
      const quickOutput = store.readOutput(completedQuickRecord);
      assert.match(quickOutput, /quick answer/);
      assert.doesNotMatch(quickOutput, /(?:6973;Q|(?:^|\n)[XD];|\u0007)/);
      assert.match(agentOutput.join(""), /hidden-tool-output:unset:/);
      assert.doesNotMatch(screenOutput.join(""), /hidden-tool-output/);
      assert.notEqual(firstAgentCommandIndex, secondAgentCommandIndex);

      await new Promise<void>((resolveReady) => setImmediate(resolveReady));
      const visibleCommand = new Promise<void>((resolveCommand) => {
        const unsubscribe = controller.onCommand((command) => {
          if (command.command !== "printf 'visible-shell-output\\n'") return;
          unsubscribe();
          resolveCommand();
        });
      });
      controller.write("\rprintf 'visible-shell-output\\n'\r");
      await visibleCommand;
      assert.match(screenOutput.join(""), /visible-shell-output/);
    } finally {
      Reflect.set(controller, "attached", false);
      if (stdoutWriteDescriptor === undefined) {
        Reflect.deleteProperty(process.stdout, "write");
      } else {
        Object.defineProperty(process.stdout, "write", stdoutWriteDescriptor);
      }
    }

    const abortQuickCommand = "termia abort-test";
    const abortQuickRecord = new Promise<CommandRecord>((resolveRecord) => {
      const unsubscribe = controller.onCommand((command) => {
        if (command.command !== abortQuickCommand) return;
        unsubscribe();
        resolveRecord(command);
      });
    });
    const abortedQuickRequest = new Promise<void>((resolveRequest, rejectRequest) => {
      const timeout = setTimeout(() => rejectRequest(new Error("Timed out waiting for aborted quick ask")), 5_000);
      const unsubscribe = controller.onQuickAsk((request) => {
        unsubscribe();
        assert.deepEqual(request.argv, ["abort-test"]);
        void (async () => {
          const abort = new AbortController();
          const startedAt = Date.now();
          const interrupted = controller.execute("sleep 10", { signal: abort.signal });
          setTimeout(() => abort.abort(), 100);
          assert.notEqual((await interrupted).exitCode, 0);
          assert.ok(Date.now() - startedAt < 3_000);
          controller.completeQuickAsk(130);
        })().then(resolveRequest, rejectRequest).finally(() => clearTimeout(timeout));
      });
    });
    controller.write(`\r${abortQuickCommand}\r`);
    const [abortedCommand] = await Promise.all([abortQuickRecord, abortedQuickRequest]);
    assert.equal(abortedCommand.exitCode, 130);
    assert.equal(
      store.listCommands(100).some((command) => command.command === "D;130"),
      false,
    );

    await new Promise<void>((resolveReady) => setImmediate(resolveReady));
    const transcript = readFileSync(printed.transcriptPath, "utf8");
    assert.match(transcript, /\[termia\] /);
    assert.doesNotMatch(transcript, /\[termia\] \[termia\] /);
    const interactiveCommands: string[] = [];
    const interactiveCommand = new Promise<void>((resolveCommand) => {
      const unsubscribe = controller.onCommand((command) => {
        interactiveCommands.push(command.command);
        if (command.command === "printf 'interactive command\\n'") {
          unsubscribe();
          resolveCommand();
        }
      });
    });
    controller.write("\rprintf 'interactive command\\n'\r");
    await interactiveCommand;
    assert.deepEqual(interactiveCommands, ["printf 'interactive command\\n'"]);
    assert.equal(
      store.listCommands(100).some((command) => command.command.startsWith("__termia_")),
      false,
    );
  } finally {
    controller.dispose();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("keeps bash state and cwd in one persistent PTY", async () => {
  await verifyPersistentShell("/bin/bash");
});

test("keeps zsh state and cwd in one persistent PTY", { skip: zsh === undefined }, async () => {
  await verifyPersistentShell(zsh!);
});

for (const shellName of ["ash", "sh"] as const) {
  test(`runs Agent commands in ${shellName} when it is BusyBox ash`, async () => {
    const root = mkdtempSync(join(tmpdir(), `termia-${shellName}-`));
    const cwd = join(root, "cwd");
    const target = join(cwd, "target");
    mkdirSync(target, { recursive: true });
    const shell = join(root, shellName);
    if (shellName === "ash") {
      symlinkSync("/bin/bash", shell);
    } else {
      const busybox = join(root, "busybox");
      writeFileSync(busybox, "#!/bin/sh\nexec /bin/bash \"$@\"\n");
      chmodSync(busybox, 0o700);
      symlinkSync(busybox, shell);
    }
    const store = new HistoryStore(join(root, "state"));
    const controller = new TerminalController(store);

    try {
      controller.start(cwd, shell);
      const command = await controller.execute(`cd ${target}; printf 'ash-agent:%s\\n' "$PWD"`, {
        signal: AbortSignal.timeout(10_000),
      });
      assert.equal(command.exitCode, 0);
      assert.equal(controller.cwd, target);
      assert.match(store.readOutput(command), /ash-agent:.*\/target/);

      const manualCommand = `cd ${cwd}; printf 'ash-manual:%s\\n' "$PWD"`;
      const manualRecord = waitForCommand(controller, manualCommand);
      controller.write(`${manualCommand}\r`);
      const completed = await manualRecord;
      assert.equal(completed.exitCode, 0);
      assert.equal(completed.cwd, target);
      assert.equal(controller.cwd, cwd);
      assert.match(store.readOutput(completed), /ash-manual:.*\/cwd/);
    } finally {
      controller.dispose();
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("runs Agent commands and quick asks in BusyBox ash", { skip: ash === undefined }, async () => {
  const root = mkdtempSync(join(tmpdir(), "termia-busybox-ash-"));
  const cwd = join(root, "cwd");
  const target = join(cwd, "target");
  mkdirSync(target, { recursive: true });
  const shell = join(root, "ash");
  symlinkSync(ash!, shell);
  const store = new HistoryStore(join(root, "state"));
  const controller = new TerminalController(store);

  try {
    controller.start(cwd, shell);
    await controller.execute("export TERMIA_ASH_VALUE=kept", { signal: AbortSignal.timeout(3_000) });
    const command = await controller.execute(
      `cd ${target}; printf 'busybox:%s:%s\\n' "$TERMIA_ASH_VALUE" "$PWD"`,
      { signal: AbortSignal.timeout(3_000) },
    );
    assert.equal(command.exitCode, 0);
    assert.equal(controller.cwd, target);
    assert.match(store.readOutput(command), /busybox:kept:.*\/target/);

    const longValue = "x".repeat(600);
    const longCommand = await controller.execute(`printf '%s\\n' '${longValue}'`, {
      signal: AbortSignal.timeout(3_000),
    });
    assert.match(store.readOutput(longCommand), new RegExp(longValue));
    assert.equal(
      store.listCompletedCommands(20).some((record) => record.command.startsWith("__termia_")),
      false,
    );

    const abort = new AbortController();
    const interrupted = controller.execute("sleep 10", { signal: abort.signal });
    setTimeout(() => abort.abort(), 100);
    assert.notEqual((await interrupted).exitCode, 0);

    const manualCommand = "printf 'busybox-manual\\n'";
    const manualRecord = waitForCommand(controller, manualCommand);
    controller.write(`${manualCommand}\r`);
    const completed = await manualRecord;
    assert.equal(completed.exitCode, 0);
    assert.equal(store.readOutput(completed), "busybox-manual\r\n");
    await waitForShellReady(controller);

    const failedRecord = waitForCommand(controller, "false");
    controller.write("false\r");
    assert.equal((await failedRecord).exitCode, 1);

    const quickRequest = new Promise<void>((resolveRequest) => {
      const unsubscribe = controller.onQuickAsk(() => {
        unsubscribe();
        controller.completeQuickAsk(0);
        resolveRequest();
      });
    });
    const quickRecord = new Promise<CommandRecord>((resolveRecord) => {
      const unsubscribe = controller.onCommand((record) => {
        if (record.command !== "termia ash-check") return;
        unsubscribe();
        resolveRecord(record);
      });
    });
    controller.write("termia ash-check\r");
    const [, record] = await Promise.all([quickRequest, quickRecord]);
    assert.equal(record.exitCode, 0);
  } finally {
    controller.dispose();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("ignores Ctrl+] while a quick ask is running", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "termia-terminal-keys-"));
  const cwd = join(root, "cwd");
  mkdirSync(cwd);
  const store = new HistoryStore(join(root, "state"));
  const controller = new TerminalController(store);
  const stdinDescriptors = {
    isTTY: Object.getOwnPropertyDescriptor(process.stdin, "isTTY"),
    isRaw: Object.getOwnPropertyDescriptor(process.stdin, "isRaw"),
    setRawMode: Object.getOwnPropertyDescriptor(process.stdin, "setRawMode"),
  };
  const stdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
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
  t.after(() => {
    controller.dispose();
    process.stdin.pause();
    store.close();
    restore(process.stdin, "isTTY", stdinDescriptors.isTTY);
    restore(process.stdin, "isRaw", stdinDescriptors.isRaw);
    restore(process.stdin, "setRawMode", stdinDescriptors.setRawMode);
    restore(process.stdout, "isTTY", stdoutIsTTY);
    rmSync(root, { recursive: true, force: true });
  });

  controller.start(cwd, "/bin/bash");
  await controller.execute("true");
  const quickStarted = new Promise<void>((resolve) => {
    const unsubscribe = controller.onQuickAsk(() => {
      unsubscribe();
      resolve();
    });
  });
  controller.write("\rtermia wait\r");
  await quickStarted;

  const tui = { start() {}, stop() {}, requestRender() {} };
  const ctx = {
    ui: {
      custom: (factory: (...args: unknown[]) => unknown) => new Promise((resolve) => {
        factory(tui, undefined, undefined, resolve);
      }),
    },
  } as unknown as Parameters<TerminalController["enter"]>[0];
  let aborts = 0;
  let detached = false;
  const attachment = controller.enter(ctx, { onQuickAskAbort: () => aborts += 1 });
  void attachment.then(() => detached = true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  process.stdin.emit("data", Buffer.from([0x1d]));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(aborts, 0);
  assert.equal(detached, false);

  controller.dispose();
  assert.equal((await attachment).type, "detach");
});

test("automatically handles multiple interactive Agent jobs and ignores Ctrl+]", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "termia-agent-interaction-"));
  const cwd = join(root, "cwd");
  mkdirSync(cwd);
  const store = new HistoryStore(join(root, "state"));
  const controller = new TerminalController(store);
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
  let selectorCount = 0;
  let rawCount = 0;
  let openCount = 0;
  let maxOpen = 0;
  const tui = {
    start: () => starts += 1,
    stop: () => stops += 1,
    requestRender: () => {},
  };
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
  };
  const ui = {
    custom: (factory: (...args: unknown[]) => unknown) => {
      openCount += 1;
      maxOpen = Math.max(maxOpen, openCount);
      const promise = new Promise<unknown>((resolve) => {
        const component = factory(tui, theme, undefined, resolve) as { handleInput(data: string): void };
        if (component instanceof AgentJobSelector) {
          selectorCount += 1;
          setImmediate(() => {
            if (selectorCount === 2) component.handleInput("\u001b[B");
            component.handleInput("\x1d");
            component.handleInput("\r");
          });
          return;
        }
        rawCount += 1;
        if (rawCount === 1) {
          setTimeout(() => process.stdin.emit("data", Buffer.from("\x1done-a\r")), 30);
          setTimeout(() => process.stdin.emit("data", Buffer.from([0x07])), 120);
        } else if (rawCount === 2) {
          setTimeout(() => process.stdin.emit("data", Buffer.from("\x1dtwo-a\rtwo-b\r")), 30);
        } else {
          setTimeout(() => process.stdin.emit("data", Buffer.from("\x1done-b\r")), 30);
        }
      });
      return promise.finally(() => {
        openCount -= 1;
      });
    },
  };
  controller.setUi(ui as Parameters<TerminalController["setUi"]>[0]);
  t.after(() => {
    controller.setUi(undefined);
    controller.dispose();
    process.stdin.pause();
    store.close();
    restore(process.stdin, "isTTY", stdinDescriptors.isTTY);
    restore(process.stdin, "isRaw", stdinDescriptors.isRaw);
    restore(process.stdin, "setRawMode", stdinDescriptors.setRawMode);
    restore(process.stdout, "isTTY", stdoutDescriptors.isTTY);
    restore(process.stdout, "write", stdoutDescriptors.write);
    rmSync(root, { recursive: true, force: true });
  });

  controller.start(cwd, "/bin/bash");
  const oneOutput: Buffer[] = [];
  const twoOutput: Buffer[] = [];
  const timeout = AbortSignal.timeout(8_000);
  const one = controller.executeAgent([
    "printf 'job-one:first?\\n'",
    "read -r one",
    "printf 'job-one:second?\\n'",
    "read -r two",
    "printf 'job-one:%s:%s\\n' \"$one\" \"$two\"",
  ].join("; "), { signal: timeout, onOutput: (data) => oneOutput.push(data) });
  const two = controller.executeAgent([
    "printf 'job-two:first?\\n'",
    "read -r one",
    "printf 'job-two:second?\\n'",
    "read -r two",
    "printf 'job-two:%s:%s\\n' \"$one\" \"$two\"",
  ].join("; "), { signal: timeout, onOutput: (data) => twoOutput.push(data) });
  const [oneResult, twoResult] = await Promise.all([one, two]);

  assert.equal(oneResult.exitCode, 0);
  assert.equal(twoResult.exitCode, 0);
  assert.match(Buffer.concat(oneOutput).toString(), /job-one:one-a:one-b/);
  assert.doesNotMatch(Buffer.concat(oneOutput).toString(), /two-a|two-b/);
  assert.match(Buffer.concat(twoOutput).toString(), /job-two:two-a:two-b/);
  assert.doesNotMatch(Buffer.concat(twoOutput).toString(), /one-a|one-b/);
  assert.match(screen.join(""), /job-one:first\?/);
  assert.match(screen.join(""), /job-two:first\?/);
  assert.equal(selectorCount, 2);
  assert.equal(rawCount, 3);
  assert.equal(maxOpen, 1);
  assert.equal(starts, stops);
  assert.equal(starts, 3);
  assert.equal(openCount, 0);
  assert.equal(store.listCompletedCommands(20).length, 0);
});

test("allows only one terminal attachment", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "termia-terminal-attach-"));
  const store = new HistoryStore(join(root, "state"));
  const controller = new TerminalController(store);
  const writes = installFakePty(controller);
  const stdinDescriptors = {
    isTTY: Object.getOwnPropertyDescriptor(process.stdin, "isTTY"),
    isRaw: Object.getOwnPropertyDescriptor(process.stdin, "isRaw"),
    setRawMode: Object.getOwnPropertyDescriptor(process.stdin, "setRawMode"),
  };
  const stdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
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
  t.after(() => {
    controller.dispose();
    process.stdin.pause();
    store.close();
    restore(process.stdin, "isTTY", stdinDescriptors.isTTY);
    restore(process.stdin, "isRaw", stdinDescriptors.isRaw);
    restore(process.stdin, "setRawMode", stdinDescriptors.setRawMode);
    restore(process.stdout, "isTTY", stdoutIsTTY);
    rmSync(root, { recursive: true, force: true });
  });

  let starts = 0;
  let stops = 0;
  const tui = {
    start: () => starts += 1,
    stop: () => stops += 1,
    requestRender: () => {},
  };
  const ctx = {
    ui: {
      custom: (factory: (...args: unknown[]) => unknown) => new Promise((resolve) => {
        factory(tui, undefined, undefined, resolve);
      }),
    },
  } as unknown as Parameters<TerminalController["enter"]>[0];
  const baselineListeners = process.stdin.listenerCount("data");
  const first = controller.enter(ctx, { refresh: false });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const second = controller.enter(ctx, { refresh: false });

  try {
    const outcome = await Promise.race([
      second.then(
        () => "resolved",
        (error: unknown) => `rejected:${String(error)}`,
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 50)),
    ]);
    assert.equal(outcome, "rejected:Error: Termia terminal is already attached");
    assert.equal(process.stdin.listenerCount("data"), baselineListeners + 1);
    assert.equal(stops, 1);
    const beforeInput = writes.length;
    process.stdin.emit("data", Buffer.from("password\r"));
    assert.equal(writes.length, beforeInput + 1);
    assert.equal(Buffer.from(writes.at(-1)!).toString(), "password\r");
  } finally {
    process.stdin.emit("data", Buffer.from([0x1d]));
    await Promise.allSettled([first, second]);
  }
  assert.equal(process.stdin.listenerCount("data"), baselineListeners);
  assert.equal(starts, 1);
});

class TerminalMounts implements MountOperations {
  private readonly bindings = new Map<string, WorkspaceBinding>();

  async mount(hops: readonly SshHop[], cwd: string): Promise<WorkspaceBinding> {
    const shellId = hops.at(-1)?.shellId;
    if (shellId === undefined) throw new Error("missing shell");
    const binding = sshWorkspace(hops, cwd, `/tmp/mount-${shellId}`);
    this.bindings.set(shellId, binding);
    return binding;
  }

  updateCwd(binding: WorkspaceBinding, cwd: string): WorkspaceBinding {
    if (binding.target.scheme !== "ssh" || binding.mountRoot === undefined) return binding;
    return sshWorkspace(binding.target.hops, cwd, binding.mountRoot);
  }

  health(shellId: string): boolean {
    return this.bindings.has(shellId);
  }

  async unmount(shellId: string): Promise<void> {
    this.bindings.delete(shellId);
  }

  async dispose(): Promise<void> {
    this.bindings.clear();
  }
}

test("routes SSH protocol events into workspace bindings", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "termia-terminal-workspace-"));
  const cwd = join(root, "cwd");
  mkdirSync(cwd);
  const store = new HistoryStore(join(root, "state"));
  const controller = new TerminalController(store, new TerminalMounts());
  t.after(() => {
    controller.dispose();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  controller.start(cwd, "/bin/bash");
  await controller.execute("true");

  const parentShellId = Reflect.get(controller, "activeShellId") as string;
  const consume = Reflect.get(controller, "consumeToken") as (token: unknown) => void;
  assert.doesNotThrow(() => consume.call(controller, {
    type: "sshOpen",
    parentShellId: "not-the-leaf",
    shellId: "forged",
    destination: "host-forged",
    user: "mallory",
    host: "127.0.0.1",
    port: 22,
    controlPath: "/tmp/forged/control",
    cwd: "/tmp",
  }));
  assert.equal(controller.workspace.piCwd, cwd);
  const open: SshOpenEvent = {
    type: "sshOpen",
    parentShellId,
    shellId: "shell-a",
    destination: "host-a",
    user: "alice",
    host: "10.0.0.10",
    port: 22,
    controlPath: "/tmp/termia-a/control",
    cwd: "/home/alice",
  };
  consume.call(controller, open);

  assert.equal(
    workspaceUri((await controller.readyWorkspace("shell-a")).target),
    "ssh://alice@10.0.0.10/home/alice",
  );
  consume.call(controller, {
    type: "ready",
    shellId: "shell-a",
    cwd: "/srv/app",
    explicitExec: true,
  });
  assert.equal(controller.workspace.piCwd, "/tmp/mount-shell-a/srv/app");
  const observedRecord = waitForCommand(controller, "pwd");
  consume.call(controller, { type: "output", data: "[termia] /srv/app $ pwd\r\n/srv/app\r\n" });
  consume.call(controller, {
    type: "observed",
    shellId: "shell-a",
    historyId: 1,
    cwd: "/srv/app",
    command: "pwd",
    exitCode: 0,
  });
  const observed = await observedRecord;
  assert.equal(observed.workspaceUri, "ssh://alice@10.0.0.10/srv/app");
  assert.equal(store.readOutput(observed), "/srv/app\r\n");
  consume.call(controller, { type: "sshClose", shellId: "shell-a" });
  await new Promise<void>((resolveTick) => setImmediate(resolveTick));
  assert.equal(controller.workspace.piCwd, cwd);
});
