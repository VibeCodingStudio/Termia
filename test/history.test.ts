import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { HistoryStore } from "../extensions/termia/history.ts";

const localContext = { workspaceUri: "file:///tmp", hopChain: [] };
const hostAContext = { workspaceUri: "ssh://alice@host-a/home/alice", hopChain: ["host-a"] };

function createLegacyHistoryDatabase(root: string): void {
  const transcriptRoot = join(root, "transcripts");
  const transcriptPath = join(transcriptRoot, "legacy.log");
  mkdirSync(transcriptRoot, { recursive: true });
  writeFileSync(transcriptPath, "ok\n");
  const database = new DatabaseSync(join(root, "history.db"));
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE terminal_sessions (
      id TEXT PRIMARY KEY,
      shell TEXT NOT NULL,
      initial_cwd TEXT NOT NULL,
      transcript_path TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER
    ) STRICT;
    CREATE TABLE commands (
      id TEXT PRIMARY KEY,
      terminal_session_id TEXT NOT NULL REFERENCES terminal_sessions(id),
      command TEXT NOT NULL,
      cwd TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      exit_code INTEGER,
      output_start INTEGER NOT NULL,
      output_end INTEGER
    ) STRICT;
  `);
  database.prepare(`
    INSERT INTO terminal_sessions
      (id, shell, initial_cwd, transcript_path, started_at, ended_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("legacy-terminal", "/bin/bash", "/tmp", transcriptPath, 1, 3);
  database.prepare(`
    INSERT INTO commands
      (id, terminal_session_id, command, cwd, started_at, ended_at, exit_code, output_start, output_end)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("legacy-command", "legacy-terminal", "pwd", "/tmp", 1, 2, 0, 0, 3);
  database.close();
}

test("records command metadata against transcript byte offsets", (t) => {
  const root = mkdtempSync(join(tmpdir(), "termia-history-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const store = new HistoryStore(root);
  store.startTerminal({ id: "t1", shell: "/bin/bash", cwd: "/tmp", startedAt: 10 });
  store.appendOutput("你\n");
  store.startCommand(
    { type: "start", shellId: "local", sequence: 1, cwd: "/tmp", command: "echo 世界" },
    localContext,
    20,
  );
  store.appendOutput("世界\n");
  store.endCommand({ type: "end", shellId: "local", sequence: 1, cwd: "/tmp", exitCode: 0 }, 30);

  const [command] = store.listCommands(10);
  assert.ok(command);
  assert.equal(Number.isSafeInteger(command.index), true);
  assert.equal(command.index > 0, true);
  assert.deepEqual(store.getCommand(command.index), command);
  assert.equal(store.getCommand(command.index + 1), undefined);
  assert.throws(() => store.getCommand(0), /positive integer/);
  assert.equal(command.command, "echo 世界");
  assert.equal(command.exitCode, 0);
  assert.equal(store.readOutput(command), "世界\n");
  assert.throws(
    () => store.readOutput({ ...command, transcriptPath: join(root, "outside.log") }),
    /transcripts/,
  );
  store.close(40);
});

test("records a completed ash command from the previous prompt boundary", (t) => {
  const root = mkdtempSync(join(tmpdir(), "termia-history-observed-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const store = new HistoryStore(root);
  store.startTerminal({ id: "t1", shell: "/bin/ash", cwd: "/tmp", startedAt: 10 });
  const outputBoundary = store.outputOffset;
  store.appendOutput("[termia] /tmp $ printf 'hello\\n'\r\nhello\r\n");
  const command = store.recordObservedCommand(
    {
      type: "observed",
      shellId: "local",
      historyId: 1,
      cwd: "/tmp",
      command: "printf 'hello\\n'",
      exitCode: 0,
    },
    localContext,
    { cwd: "/tmp", outputOffset: outputBoundary },
    20,
    30,
  );

  assert.equal(command.command, "printf 'hello\\n'");
  assert.equal(command.startedAt, 20);
  assert.equal(command.endedAt, 30);
  assert.equal(command.exitCode, 0);
  assert.equal(store.readOutput(command), "hello\r\n");
  store.close(40);
});

test("starts a fresh shell after the previous terminal ends", (t) => {
  const root = mkdtempSync(join(tmpdir(), "termia-history-restart-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const store = new HistoryStore(root);
  store.startTerminal({ id: "t1", shell: "/bin/bash", cwd: "/tmp" });
  store.endTerminal();
  store.startTerminal({ id: "t2", shell: "/bin/bash", cwd: "/tmp" });
  store.close();
});

test("keeps equal command sequences from different shells independent", (t) => {
  const root = mkdtempSync(join(tmpdir(), "termia-history-shells-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const store = new HistoryStore(root);
  store.startTerminal({ id: "t1", shell: "/bin/bash", cwd: "/tmp" });
  store.startCommand(
    { type: "start", shellId: "shell-a", sequence: 1, cwd: "/tmp", command: "a" },
    hostAContext,
  );
  store.startCommand(
    { type: "start", shellId: "shell-b", sequence: 1, cwd: "/tmp", command: "b" },
    { workspaceUri: "ssh://bob@host-b/tmp", hopChain: ["host-a", "host-b"] },
  );

  const b = store.endCommand({ type: "end", shellId: "shell-b", sequence: 1, cwd: "/tmp", exitCode: 2 });
  const a = store.endCommand({ type: "end", shellId: "shell-a", sequence: 1, cwd: "/tmp", exitCode: 1 });

  assert.equal(a?.command, "a");
  assert.equal(a?.exitCode, 1);
  assert.equal(a?.shellId, "shell-a");
  assert.equal(a?.workspaceUri, "ssh://alice@host-a/home/alice");
  assert.deepEqual(a?.hopChain, ["host-a"]);
  assert.equal(b?.command, "b");
  assert.equal(b?.exitCode, 2);
  store.close();
});

test("discards the parent ssh command without deleting child commands", (t) => {
  const root = mkdtempSync(join(tmpdir(), "termia-history-boundary-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new HistoryStore(root);
  store.startTerminal({ id: "t1", shell: "/bin/bash", cwd: "/tmp" });
  store.startCommand(
    { type: "start", shellId: "local", sequence: 3, cwd: "/tmp", command: "ssh host-a" },
    localContext,
  );
  store.discardActiveCommand("local");
  store.startCommand(
    { type: "start", shellId: "shell-a", sequence: 1, cwd: "/home/alice", command: "pwd" },
    hostAContext,
  );
  store.endCommand({
    type: "end",
    shellId: "shell-a",
    sequence: 1,
    cwd: "/home/alice",
    exitCode: 0,
  });
  assert.deepEqual(store.listCommands().map((record) => record.command), ["pwd"]);
  store.close();
});

test("migrates pre-SSH history with local provenance defaults", (t) => {
  const root = mkdtempSync(join(tmpdir(), "termia-history-legacy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  createLegacyHistoryDatabase(root);
  const store = new HistoryStore(root);
  const legacy = store.listCommands(1)[0];
  assert.equal(legacy?.shellId, "local");
  assert.equal(legacy?.workspaceUri, "file:///tmp");
  assert.deepEqual(legacy?.hopChain, []);
  store.close();
});
