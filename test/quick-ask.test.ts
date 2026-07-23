import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HistoryStore } from "../extensions/termia/history.ts";
import {
  buildQuickMessages,
  parseQuickAskArguments,
  selectQuickHistory,
} from "../extensions/termia/quick-ask.ts";

test("delegates Pi print arguments while consuming Termia history options", () => {
  const invocation = parseQuickAskArguments([
    "--provider",
    "openai-codex",
    "--model",
    "gpt-5.2-codex",
    "--thinking",
    "high",
    "-n",
    "3",
    "why did it fail?",
  ]);

  assert.equal(invocation.attach, false);
  assert.deepEqual(invocation.history, { kind: "last", count: 3 });
  assert.equal(invocation.piArgs.provider, "openai-codex");
  assert.equal(invocation.piArgs.model, "gpt-5.2-codex");
  assert.equal(invocation.piArgs.thinking, "high");
  assert.deepEqual(invocation.piArgs.messages, ["why did it fail?"]);
});

test("supports compact history selection and harmless Pi print flags", () => {
  const invocation = parseQuickAskArguments(["h~12", "--print", "--no-session", "summarize"]);

  assert.deepEqual(invocation.history, { kind: "last", count: 12 });
  assert.deepEqual(invocation.piArgs.messages, ["summarize"]);
});

test("supports all history with an explicit bounded selection", () => {
  const invocation = parseQuickAskArguments(["--all", "explain the terminal session"]);
  assert.deepEqual(invocation.history, { kind: "all" });
});

test("rejects ambiguous, unsafe, and unsupported quick-ask arguments", () => {
  assert.throws(
    () => parseQuickAskArguments(["-n", "2", "h~3", "question"]),
    /one history selector/,
  );
  assert.throws(() => parseQuickAskArguments(["-n", "0", "question"]), /positive integer/);
  assert.throws(() => parseQuickAskArguments(["--continue", "question"]), /not supported/);
  assert.throws(() => parseQuickAskArguments(["@notes.md", "question"]), /@file/);
  assert.throws(() => parseQuickAskArguments([]), /prompt/);
});

test("attach accepts only prompt and history arguments", () => {
  const invocation = parseQuickAskArguments(["--attach", "--last", "2", "follow up"]);
  assert.equal(invocation.attach, true);
  assert.deepEqual(invocation.history, { kind: "last", count: 2 });
  assert.deepEqual(invocation.piArgs.messages, ["follow up"]);

  assert.throws(
    () => parseQuickAskArguments(["--attach", "--model", "gpt-5.2-codex", "question"]),
    /--attach.*model/,
  );
});

test("selects only completed commands and injects metadata in chronological order", (t) => {
  const root = mkdtempSync(join(tmpdir(), "termia-quick-ask-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const store = new HistoryStore(root);
  store.startTerminal({ id: "t1", shell: "/bin/bash", cwd: "/work", startedAt: 1 });
  const context = { shellId: "local", workspaceUri: "file:///work", hopChain: [] };
  store.startCommand({ type: "start", shellId: "local", sequence: 1, cwd: "/work", command: "first" }, context, 10);
  store.appendOutput("first output\n");
  store.endCommand({ type: "end", shellId: "local", sequence: 1, cwd: "/work", exitCode: 0 }, 20);
  store.startCommand({ type: "start", shellId: "local", sequence: 2, cwd: "/work/sub", command: "second" }, context, 30);
  store.appendOutput("second output\n");
  store.endCommand({ type: "end", shellId: "local", sequence: 2, cwd: "/work/sub", exitCode: 7 }, 45);
  store.startCommand({ type: "start", shellId: "local", sequence: 3, cwd: "/work", command: "still-running" }, context, 50);

  const commands = selectQuickHistory(store, { kind: "last", count: 2 });
  assert.deepEqual(commands.map((command) => command.command), ["first", "second"]);

  const messages = buildQuickMessages(["why?", "extra"], commands);
  assert.equal(messages.length, 2);
  assert.match(messages[0] ?? "", /Termia history #1/);
  assert.match(messages[0] ?? "", /command: first[\s\S]*command: second[\s\S]*why\?/);
  assert.doesNotMatch(messages[0] ?? "", /first output|second output|still-running/);
  assert.equal(messages[1], "extra");
  store.close();
});
