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
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import type { IPty } from "node-pty";
import { createActiveWorkspace } from "../extensions/termia/active-workspace.ts";
import { HistoryStore, type CommandRecord } from "../extensions/termia/history.ts";
import { isTermiaPty, TerminalController } from "../extensions/termia/terminal.ts";

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

function createTestTerminal(history: HistoryStore): TerminalController {
  const { terminal } = createActiveWorkspace(process.cwd(), {
    run: async () => ({ exitCode: 0 }),
  });
  return new TerminalController(history, terminal);
}

function installFakeTerminalStdio(t: TestContext): string[] {
  const stdinDescriptors = {
    isTTY: Object.getOwnPropertyDescriptor(process.stdin, "isTTY"),
    isRaw: Object.getOwnPropertyDescriptor(process.stdin, "isRaw"),
    setRawMode: Object.getOwnPropertyDescriptor(process.stdin, "setRawMode"),
  };
  const stdoutDescriptors = {
    isTTY: Object.getOwnPropertyDescriptor(process.stdout, "isTTY"),
    write: Object.getOwnPropertyDescriptor(process.stdout, "write"),
  };
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const restore = (target: object, key: string, descriptor: PropertyDescriptor | undefined) => {
    if (descriptor === undefined) Reflect.deleteProperty(target, key);
    else Object.defineProperty(target, key, descriptor);
  };
  const stdoutWrites: string[] = [];

  Object.defineProperties(process.stdin, {
    isTTY: { configurable: true, value: true },
    isRaw: { configurable: true, writable: true, value: false },
    setRawMode: {
      configurable: true,
      value: (raw: boolean) => Reflect.set(process.stdin, "isRaw", raw),
    },
  });
  Object.defineProperties(process.stdout, {
    isTTY: { configurable: true, value: true },
    write: {
      configurable: true,
      value: (...args: Parameters<typeof process.stdout.write>) => {
        const [chunk] = args;
        stdoutWrites.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
        if (typeof chunk === "string") return true;
        return stdoutWrite(...args);
      },
    },
  });

  t.after(() => {
    process.stdin.pause();
    restore(process.stdin, "isTTY", stdinDescriptors.isTTY);
    restore(process.stdin, "isRaw", stdinDescriptors.isRaw);
    restore(process.stdin, "setRawMode", stdinDescriptors.setRawMode);
    restore(process.stdout, "isTTY", stdoutDescriptors.isTTY);
    restore(process.stdout, "write", stdoutDescriptors.write);
  });
  return stdoutWrites;
}

test("detects only the Termia PTY marker", () => {
  assert.equal(isTermiaPty("1"), true);
  assert.equal(isTermiaPty("0"), false);
  assert.equal(isTermiaPty(undefined), false);
});

test("publishes shell workspace facts through TerminalWorkspaceFeed", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "termia-terminal-feed-"));
  const cwd = join(root, "cwd");
  mkdirSync(join(cwd, "child"), { recursive: true });
  const store = new HistoryStore(join(root, "state"));
  const local = createLocalBashOperations();
  const facets = createActiveWorkspace(cwd, {
    run: ({ command, cwd: commandCwd, options }) =>
      local.exec(command, commandCwd, options),
  });
  const controller = new TerminalController(store, facets.terminal);
  t.after(async () => {
    controller.dispose();
    await facets.workspace[Symbol.asyncDispose]();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  controller.start(cwd, "/bin/bash");
  const record = await controller.execute("cd child");
  const activation = await facets.workspace.prepare(record.shellId);

  assert.equal(activation.kind, "ready");
  assert.equal(activation.pending.uri, pathToFileURL(join(cwd, "child")).href);
  assert.equal(facets.workspace.current().summary.uri, pathToFileURL(cwd).href);
});

test("stages a shell without competing for the active HistoryStore", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "termia-terminal-stage-"));
  const cwd = join(root, "cwd");
  mkdirSync(cwd);
  const history = new HistoryStore(join(root, "state"));
  const currentFacets = createActiveWorkspace(cwd, {
    run: async () => ({ exitCode: 0 }),
  });
  const stagedFacets = createActiveWorkspace(cwd, {
    run: async () => ({ exitCode: 0 }),
  });
  const current = new TerminalController(history, currentFacets.terminal);
  const staged = new TerminalController(history, stagedFacets.terminal);
  t.after(async () => {
    current.dispose();
    staged.dispose();
    await currentFacets.workspace[Symbol.asyncDispose]();
    await stagedFacets.workspace[Symbol.asyncDispose]();
    history.close();
    rmSync(root, { recursive: true, force: true });
  });

  current.start(cwd, "/bin/bash");
  await current.execute("true");
  await staged.stage(cwd, "/bin/bash");

  assert.equal(staged.running, true);
  assert.throws(() => staged.write("pwd\r"), /staged terminal is not committed/);
  await assert.rejects(staged.execute("pwd"), /staged terminal is not committed/);
  assert.throws(() => staged.commitStaged(), /already active/);

  current.dispose();
  staged.commitStaged();
  const record = await staged.execute("printf reset-ready");
  assert.equal(record.exitCode, 0);
  assert.match(history.readOutput(record), /reset-ready/);
});

test("rejects staging when the candidate shell exits before ready", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "termia-terminal-stage-exit-"));
  const cwd = join(root, "cwd");
  const shell = join(root, "bash");
  mkdirSync(cwd);
  writeFileSync(shell, "#!/bin/sh\nexit 12\n");
  chmodSync(shell, 0o700);
  const history = new HistoryStore(join(root, "state"));
  const controller = createTestTerminal(history);
  t.after(() => {
    controller.dispose();
    history.close();
    rmSync(root, { recursive: true, force: true });
  });

  await assert.rejects(
    controller.stage(cwd, shell),
    /staged terminal exited before shell ready/,
  );
  assert.equal(controller.running, false);
});

test("uses and removes a private runtime hook directory", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "termia-terminal-runtime-"));
  const cwd = join(root, "cwd");
  mkdirSync(cwd);
  const store = new HistoryStore(join(root, "state"));
  const controller = createTestTerminal(store);
  t.after(() => {
    controller.dispose();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  controller.start(cwd, "/bin/bash");
  await controller.execute("true");
  const runtime = Reflect.get(controller, "identityRuntime") as
    | { hookDirectory: string; privateKey?: string }
    | undefined;
  assert.ok(runtime);
  assert.match(runtime.hookDirectory, /^\/tmp\/termia-hooks-/);
  assert.equal(existsSync(join(runtime.hookDirectory, "termia.bash")), true);
  assert.equal(existsSync(runtime.privateKey ?? ""), true);

  const hookDirectory = runtime.hookDirectory;
  controller.dispose();
  assert.equal(existsSync(hookDirectory), false);
});

test("chunks long explicit execution input below the ash line limit", async () => {
  const root = mkdtempSync(join(tmpdir(), "termia-terminal-chunks-"));
  const store = new HistoryStore(join(root, "state"));
  const controller = createTestTerminal(store);
  const writes = installFakePty(controller, true);
  const command = `printf '%s' '${"x".repeat(600)}'`;
  const pending = controller.execute(command);
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
    assert.equal(Buffer.from(encoded, "base64").toString("utf8"), command);
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
  const controller = createTestTerminal(store);
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
  const controller = createTestTerminal(store);

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
    assert.notEqual(functionCheck.exitCode, 0);
    assert.doesNotMatch(store.readOutput(functionCheck), /termia is a (?:shell )?function/);

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
    const controller = createTestTerminal(store);

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

test("runs Agent commands in BusyBox ash", { skip: ash === undefined }, async () => {
  const root = mkdtempSync(join(tmpdir(), "termia-busybox-ash-"));
  const cwd = join(root, "cwd");
  const target = join(cwd, "target");
  mkdirSync(target, { recursive: true });
  const shell = join(root, "ash");
  symlinkSync(ash!, shell);
  const store = new HistoryStore(join(root, "state"));
  const controller = createTestTerminal(store);

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

  } finally {
    controller.dispose();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("allows only one terminal attachment", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "termia-terminal-attach-"));
  const store = new HistoryStore(join(root, "state"));
  const controller = createTestTerminal(store);
  const writes = installFakePty(controller);
  store.startTerminal({ id: "attach", shell: "/bin/bash", cwd: "/tmp" });
  store.appendOutput(
    `discarded:${"x".repeat(1024 * 1024)}\n`
      + "[termia] /tmp $ echo kept\r\nkept\r\n[termia] /tmp $ ",
  );
  const offsetBeforeReplay = store.outputOffset;
  const stdoutWrites = installFakeTerminalStdio(t);
  t.after(() => {
    controller.dispose();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  let starts = 0;
  let stops = 0;
  const attachOrder: string[] = [];
  let finishDrain: (() => void) | undefined;
  const tui = {
    start: () => starts += 1,
    stop: () => {
      stops += 1;
      attachOrder.push("stop");
    },
    requestRender: () => {},
    terminal: {
      drainInput: () => new Promise<void>((resolve) => {
        attachOrder.push("drain");
        finishDrain = resolve;
      }),
    },
  };
  const ctx = {
    ui: {
      custom: (factory: (...args: unknown[]) => unknown) => new Promise((resolve) => {
        factory(tui, undefined, undefined, resolve);
      }),
    },
  } as unknown as Parameters<TerminalController["enter"]>[0];
  const baselineListeners = process.stdin.listenerCount("data");
  const first = controller.enter(ctx);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const beforeRelease = writes.length;
  process.stdin.emit("data", "\u001b[93;5:3u");
  assert.equal(writes.length, beforeRelease);
  assert.equal(process.stdin.listenerCount("data"), baselineListeners);
  finishDrain?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const second = controller.enter(ctx);

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
    assert.deepEqual(attachOrder, ["drain", "stop"]);
    assert.equal(stops, 1);
    const beforeInput = writes.length;
    process.stdin.emit("data", Buffer.from("password\r"));
    assert.equal(writes.length, beforeInput + 1);
    assert.equal(Buffer.from(writes.at(-1)!).toString(), "password\r");
    assert.equal(stdoutWrites.includes("\u001b[2J\u001b[H\u001b[0m"), true);
    assert.equal(
      stdoutWrites.includes("[termia] /tmp $ echo kept\r\nkept\r\n[termia] /tmp $ "),
      true,
    );
    assert.equal(stdoutWrites.some((data) => data.includes("discarded:")), false);
    assert.equal(store.outputOffset, offsetBeforeReplay);
    assert.equal(writes.includes("\u000c"), false);
  } finally {
    process.stdin.emit("data", Buffer.from([0x1d]));
    await Promise.allSettled([first, second]);
  }
  assert.equal(process.stdin.listenerCount("data"), baselineListeners);
  assert.equal(starts, 1);
});

test("keeps PTY attachment usable when history replay fails", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "termia-terminal-replay-error-"));
  const store = new HistoryStore(join(root, "state"));
  store.startTerminal({ id: "replay-error", shell: "/bin/bash", cwd: "/tmp" });
  store.readActiveOutputTail = () => {
    throw new Error("transcript unavailable");
  };
  const controller = createTestTerminal(store);
  installFakePty(controller);
  const stdoutWrites = installFakeTerminalStdio(t);
  t.after(() => {
    controller.dispose();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  const tui = {
    start: () => {},
    stop: () => {},
    requestRender: () => {},
    terminal: { drainInput: async () => {} },
  };
  const ctx = {
    ui: {
      custom: (factory: (...args: unknown[]) => unknown) => new Promise((resolve) => {
        factory(tui, undefined, undefined, resolve);
      }),
    },
  } as unknown as Parameters<TerminalController["enter"]>[0];

  const attachment = controller.enter(ctx);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.match(
    stdoutWrites.join(""),
    /\[termia\] Unable to replay PTY history: transcript unavailable/,
  );

  process.stdin.emit("data", Buffer.from([0x1d]));
  assert.deepEqual(await attachment, { type: "detach", shellId: "local" });
});
