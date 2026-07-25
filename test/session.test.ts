import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import test from "node:test";
import {
  SessionManager,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  createManagedSession,
  forkManagedSession,
  handoffSession,
  isManagedSession,
  prepareSessionHandoff,
  releaseManagedSession,
  retireManagedSession,
  startManagedSession,
} from "../extensions/termia/session.ts";

function appendTurn(session: SessionManager, text: string): void {
  session.appendMessage({ role: "user", content: text, timestamp: 1 });
  session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "test",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
  });
}

test("forks the active conversation into the target cwd", (t) => {
  const root = mkdtempSync(join(tmpdir(), "termia-session-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceCwd = join(root, "source");
  const targetCwd = join(root, "target");
  mkdirSync(sourceCwd);
  mkdirSync(targetCwd);
  const source = SessionManager.create(sourceCwd, join(root, "source-sessions"));
  appendTurn(source, "keep me");

  const sourceFile = source.getSessionFile();
  assert.ok(sourceFile);
  const file = forkManagedSession(sourceFile, targetCwd, root);
  const fork = SessionManager.open(file);
  assert.equal(fork.getCwd(), targetCwd);
  assert.equal(fork.buildSessionContext().messages[0]?.role, "user");
  assert.equal(isManagedSession(file, root), true);
  const location = relative(join(root, "pi-sessions"), file);
  assert.equal(location.startsWith("..") || isAbsolute(location), false);

  const retired = retireManagedSession(file, root);
  assert.ok(retired);
  assert.equal(existsSync(file), false);
  assert.equal(existsSync(retired), true);
});

test("creates a managed replacement for an empty persisted session", (t) => {
  const root = mkdtempSync(join(tmpdir(), "termia-empty-session-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceCwd = join(root, "source");
  const targetCwd = join(root, "target");
  mkdirSync(sourceCwd);
  mkdirSync(targetCwd);
  const source = SessionManager.create(sourceCwd, join(root, "source-sessions"));
  const sourceFile = source.getSessionFile();
  assert.ok(sourceFile);
  writeFileSync(sourceFile, "");

  const file = forkManagedSession(sourceFile, targetCwd, root);

  assert.equal(SessionManager.open(file).getCwd(), targetCwd);
  assert.equal(isManagedSession(file, root), true);
});

test("treats every session in the dedicated Termia directory as managed", (t) => {
  const root = mkdtempSync(join(tmpdir(), "termia-retire-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "cwd");
  mkdirSync(cwd);

  const outside = SessionManager.create(cwd, join(root, "outside"));
  appendTurn(outside, "original");
  const outsideFile = outside.getSessionFile();
  assert.ok(outsideFile);
  assert.equal(retireManagedSession(outsideFile, root), undefined);

  const unowned = SessionManager.create(cwd, join(root, "pi-sessions"));
  appendTurn(unowned, "unowned");
  const unownedFile = unowned.getSessionFile();
  assert.ok(unownedFile);
  assert.equal(isManagedSession(unownedFile, root), true);
  assert.ok(retireManagedSession(unownedFile, root));
  assert.equal(existsSync(unownedFile), false);
});

test("accepts an unflushed native Pi session without trying to retire a missing file", (t) => {
  const root = mkdtempSync(join(tmpdir(), "termia-native-new-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "cwd");
  mkdirSync(cwd);
  const session = SessionManager.create(cwd, join(root, "pi-sessions"));
  const file = session.getSessionFile();
  assert.ok(file);

  assert.equal(existsSync(file), false);
  assert.equal(isManagedSession(file, root), true);
  assert.equal(retireManagedSession(file, root), undefined);
});

test("switches to a managed session without retiring the original Pi session", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "termia-handoff-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceCwd = join(root, "source");
  const targetCwd = join(root, "target");
  mkdirSync(sourceCwd);
  mkdirSync(targetCwd);
  const source = SessionManager.create(sourceCwd, join(root, "outside"));
  appendTurn(source, "continue this");
  const sourceFile = source.getSessionFile();
  assert.ok(sourceFile);
  let switchedFile: string | undefined;

  const result = await handoffSession({
    cwd: sourceCwd,
    sessionManager: { getSessionFile: () => sourceFile },
    waitForIdle: async () => undefined,
    switchSession: async (file) => {
      switchedFile = file;
      return { cancelled: false };
    },
  }, targetCwd, root);

  assert.deepEqual(result, { cancelled: false, switched: true });
  assert.ok(switchedFile);
  assert.equal(isManagedSession(switchedFile, root), true);
  assert.equal(existsSync(sourceFile), true);
});

function transactionalContext(
  sourceCwd: string,
  targetCwd: string,
  sourceFile: string,
  switched: string[],
  rollbackBehavior: { cancelled?: boolean; error?: Error } = {},
): ExtensionCommandContext {
  type SwitchOptions = NonNullable<Parameters<ExtensionCommandContext["switchSession"]>[1]>;
  type ReplacedSessionContext = Parameters<NonNullable<SwitchOptions["withSession"]>>[0];
  const restored = {
    cwd: sourceCwd,
    sendMessage: async () => {},
    sendUserMessage: async () => {},
  } as unknown as ReplacedSessionContext;
  const replacement = {
    cwd: targetCwd,
    sendMessage: async () => {},
    sendUserMessage: async () => {},
    switchSession: async (file: string, options?: {
      withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
    }) => {
      switched.push(file);
      assert.equal(file, sourceFile);
      if (rollbackBehavior.error !== undefined) throw rollbackBehavior.error;
      if (rollbackBehavior.cancelled === true) return { cancelled: true };
      await options?.withSession?.(restored);
      return { cancelled: false };
    },
  } as unknown as ReplacedSessionContext;
  return {
    cwd: sourceCwd,
    sessionManager: { getSessionFile: () => sourceFile },
    waitForIdle: async () => undefined,
    switchSession: async (file: string, options?: SwitchOptions) => {
      switched.push(file);
      await options?.withSession?.(replacement);
      return { cancelled: false };
    },
  } as unknown as ExtensionCommandContext;
}

test("keeps the source session recoverable until a prepared handoff commits", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "termia-prepared-handoff-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceCwd = join(root, "source");
  const targetCwd = join(root, "target");
  mkdirSync(sourceCwd);
  mkdirSync(targetCwd);
  const sourceFile = createManagedSession(sourceCwd, root);
  const switched: string[] = [];

  const handoff = await prepareSessionHandoff(
    transactionalContext(sourceCwd, targetCwd, sourceFile, switched),
    targetCwd,
    root,
  );
  assert.equal(handoff.cancelled, false);
  assert.equal(handoff.switched, true);
  assert.equal(existsSync(sourceFile), true);
  assert.equal(switched.length, 1);
  const replacementFile = switched[0]!;
  assert.equal(existsSync(replacementFile), true);

  handoff.commit();

  assert.equal(existsSync(sourceFile), false);
  assert.equal(existsSync(replacementFile), true);
});

test("rolls a prepared handoff back to the source session", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "termia-rollback-handoff-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceCwd = join(root, "source");
  const targetCwd = join(root, "target");
  mkdirSync(sourceCwd);
  mkdirSync(targetCwd);
  const sourceFile = createManagedSession(sourceCwd, root);
  const switched: string[] = [];

  const handoff = await prepareSessionHandoff(
    transactionalContext(sourceCwd, targetCwd, sourceFile, switched),
    targetCwd,
    root,
  );
  assert.equal(handoff.cancelled, false);
  const replacementFile = switched[0]!;

  const restored = await handoff.rollback();

  assert.equal(restored.context?.cwd, sourceCwd);
  assert.deepEqual(switched, [replacementFile, sourceFile]);
  assert.equal(existsSync(sourceFile), true);
  assert.equal(existsSync(replacementFile), false);
});

test("automatically rolls back when replacement session initialization fails", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "termia-failed-handoff-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceCwd = join(root, "source");
  const targetCwd = join(root, "target");
  mkdirSync(sourceCwd);
  mkdirSync(targetCwd);
  const sourceFile = createManagedSession(sourceCwd, root);
  const switched: string[] = [];
  const failure = new Error("replacement initialization failed");

  await assert.rejects(
    prepareSessionHandoff(
      transactionalContext(sourceCwd, targetCwd, sourceFile, switched),
      targetCwd,
      root,
      { withSession: async () => { throw failure; } },
    ),
    (error) => error === failure,
  );

  assert.equal(switched.length, 2);
  const replacementFile = switched[0]!;
  assert.deepEqual(switched, [replacementFile, sourceFile]);
  assert.equal(existsSync(sourceFile), true);
  assert.equal(existsSync(replacementFile), false);
});

test("reports cleanup separately when failed initialization was successfully rolled back", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "termia-failed-cleanup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceCwd = join(root, "source");
  const targetCwd = join(root, "target");
  mkdirSync(sourceCwd);
  mkdirSync(targetCwd);
  const sourceFile = createManagedSession(sourceCwd, root);
  const switched: string[] = [];
  const failure = new Error("replacement initialization failed");
  const sessionDirectory = join(root, "pi-sessions");
  let thrown: unknown;
  try {
    await prepareSessionHandoff(
      transactionalContext(sourceCwd, targetCwd, sourceFile, switched),
      targetCwd,
      root,
      {
        withSession: async () => {
          chmodSync(sessionDirectory, 0o500);
          throw failure;
        },
      },
    );
  } catch (error) {
    thrown = error;
  } finally {
    chmodSync(sessionDirectory, 0o700);
  }

  assert.ok(thrown instanceof AggregateError);
  assert.equal(
    thrown.message,
    "Termia session handoff failed, rollback succeeded, and replacement cleanup failed",
  );
  assert.equal(thrown.errors[0], failure);
  assert.deepEqual(switched.length, 2);
  assert.equal(existsSync(sourceFile), true);
  assert.equal(existsSync(switched[0]!), true);
});

test("reports a cancelled prepared rollback without claiming restoration", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "termia-cancelled-rollback-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceCwd = join(root, "source");
  const targetCwd = join(root, "target");
  mkdirSync(sourceCwd);
  mkdirSync(targetCwd);
  const sourceFile = createManagedSession(sourceCwd, root);
  const switched: string[] = [];
  const handoff = await prepareSessionHandoff(
    transactionalContext(sourceCwd, targetCwd, sourceFile, switched, { cancelled: true }),
    targetCwd,
    root,
  );
  const replacementFile = switched[0]!;

  await assert.rejects(handoff.rollback(), /could not roll back/);

  assert.deepEqual(switched, [replacementFile, sourceFile]);
  assert.equal(existsSync(sourceFile), true);
  assert.equal(existsSync(replacementFile), true);
});

test("reports a thrown prepared rollback without claiming restoration", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "termia-thrown-rollback-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceCwd = join(root, "source");
  const targetCwd = join(root, "target");
  mkdirSync(sourceCwd);
  mkdirSync(targetCwd);
  const sourceFile = createManagedSession(sourceCwd, root);
  const switched: string[] = [];
  const failure = new Error("rollback hook failed");
  const handoff = await prepareSessionHandoff(
    transactionalContext(sourceCwd, targetCwd, sourceFile, switched, { error: failure }),
    targetCwd,
    root,
  );
  const replacementFile = switched[0]!;

  await assert.rejects(handoff.rollback(), (error) => error === failure);

  assert.deepEqual(switched, [replacementFile, sourceFile]);
  assert.equal(existsSync(sourceFile), true);
  assert.equal(existsSync(replacementFile), true);
});

test("commits a prepared handoff even when source archival fails", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "termia-commit-cleanup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceCwd = join(root, "source");
  const targetCwd = join(root, "target");
  mkdirSync(sourceCwd);
  mkdirSync(targetCwd);
  const sourceFile = createManagedSession(sourceCwd, root);
  const switched: string[] = [];
  const handoff = await prepareSessionHandoff(
    transactionalContext(sourceCwd, targetCwd, sourceFile, switched),
    targetCwd,
    root,
  );
  const sessionDirectory = join(root, "pi-sessions");
  let cleanupError: unknown;
  chmodSync(sessionDirectory, 0o500);
  try {
    cleanupError = handoff.commit();
  } finally {
    chmodSync(sessionDirectory, 0o700);
  }

  assert.ok(cleanupError instanceof Error);
  assert.equal(existsSync(sourceFile), true);
  assert.equal(existsSync(switched[0]!), true);
  assert.throws(() => handoff.commit(), /already settled/);
});

test("rolls back a prepared handoff even when replacement archival fails", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "termia-rollback-cleanup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceCwd = join(root, "source");
  const targetCwd = join(root, "target");
  mkdirSync(sourceCwd);
  mkdirSync(targetCwd);
  const sourceFile = createManagedSession(sourceCwd, root);
  const switched: string[] = [];
  const handoff = await prepareSessionHandoff(
    transactionalContext(sourceCwd, targetCwd, sourceFile, switched),
    targetCwd,
    root,
  );
  const replacementFile = switched[0]!;
  const sessionDirectory = join(root, "pi-sessions");
  let rollback: Awaited<ReturnType<typeof handoff.rollback>>;
  chmodSync(sessionDirectory, 0o500);
  try {
    rollback = await handoff.rollback();
  } finally {
    chmodSync(sessionDirectory, 0o700);
  }

  assert.equal(rollback.context?.cwd, sourceCwd);
  assert.ok(rollback.cleanupError instanceof Error);
  assert.equal(existsSync(sourceFile), true);
  assert.equal(existsSync(replacementFile), true);
  assert.throws(() => handoff.commit(), /already settled/);
});

test("starts Termia mode in a fresh managed session without copying the conversation", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "termia-mode-start-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "cwd");
  mkdirSync(cwd);
  const original = SessionManager.create(cwd, join(root, "original"));
  appendTurn(original, "do not copy me");
  const originalFile = original.getSessionFile();
  assert.ok(originalFile);
  let managedFile: string | undefined;

  const result = await startManagedSession({
    cwd,
    sessionManager: { getSessionFile: () => originalFile },
    waitForIdle: async () => undefined,
    switchSession: async (file) => {
      managedFile = file;
      return { cancelled: false };
    },
  }, root);

  assert.deepEqual(result, { cancelled: false, switched: true });
  assert.ok(managedFile);
  assert.equal(isManagedSession(managedFile, root), true);
  const managed = SessionManager.open(managedFile);
  assert.deepEqual(managed.buildSessionContext().messages, []);
  assert.equal(managed.getSessionDir(), join(root, "pi-sessions"));
  assert.equal(existsSync(originalFile), true);
});

test("retires a fresh managed session when entering Termia mode is cancelled", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "termia-mode-cancel-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "cwd");
  mkdirSync(cwd);
  const original = SessionManager.create(cwd, join(root, "original"));
  appendTurn(original, "stay here");
  const originalFile = original.getSessionFile();
  assert.ok(originalFile);
  let managedFile: string | undefined;

  const result = await startManagedSession({
    cwd,
    sessionManager: { getSessionFile: () => originalFile },
    waitForIdle: async () => undefined,
    switchSession: async (file) => {
      managedFile = file;
      return { cancelled: true };
    },
  }, root);

  assert.deepEqual(result, { cancelled: true, switched: false });
  assert.ok(managedFile);
  assert.equal(existsSync(managedFile), false);
  assert.equal(existsSync(originalFile), true);
});

test("leaves Termia mode by switching back to the exact original session", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "termia-mode-return-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "cwd");
  mkdirSync(cwd);
  const original = SessionManager.create(cwd, join(root, "original"));
  appendTurn(original, "return here");
  const originalFile = original.getSessionFile();
  assert.ok(originalFile);
  const managedFile = createManagedSession(cwd, root);
  let switchedFile: string | undefined;

  const result = await releaseManagedSession({
    cwd,
    sessionManager: { getSessionFile: () => managedFile },
    waitForIdle: async () => undefined,
    switchSession: async (file) => {
      switchedFile = file;
      return { cancelled: false };
    },
  }, originalFile, root);

  assert.deepEqual(result, { cancelled: false, switched: true });
  assert.equal(switchedFile, originalFile);
  assert.equal(existsSync(managedFile), true);
  assert.equal(existsSync(originalFile), true);
});
