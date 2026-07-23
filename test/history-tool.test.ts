import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { HistoryStore } from "../extensions/termia/history.ts";
import { createHistoryTool, readHistoryPage } from "../extensions/termia/history-tool.ts";

test("adds fixed operational guidance through the mode-gated history tool", () => {
  const prompt = createHistoryTool({} as HistoryStore).promptGuidelines?.join("\n") ?? "";

  assert.match(prompt, /observed system state/i);
  assert.match(prompt, /local Termia workspace/i);
  assert.match(prompt, /SSH Termia workspace/i);
  assert.match(prompt, /nested SSH/i);
  assert.match(prompt, /high-risk/i);
  assert.match(prompt, /explicitly authorized/i);
  assert.match(prompt, /confirm/i);
  assert.match(prompt, /logs.*CPU.*memory.*disk.*network.*dependencies/is);
  assert.doesNotMatch(prompt, /PM2|Kubernetes|Datadog/);
});

test("reads sanitized Termia output by index with line pagination", (t) => {
  const root = mkdtempSync(join(tmpdir(), "termia-history-tool-"));
  const store = new HistoryStore(root);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  store.startTerminal({ id: "terminal", shell: "/bin/bash", cwd: "/tmp" });
  const context = { shellId: "local", workspaceUri: "file:///tmp", hopChain: [] };
  store.startCommand({ type: "start", shellId: "local", sequence: 1, cwd: "/tmp", command: "colored" }, context);
  store.appendOutput("\u001b[31mone\r\ntwo\r\nthree\u001b[0m");
  store.endCommand({ type: "end", shellId: "local", sequence: 1, cwd: "/tmp", exitCode: 0 });
  store.startCommand({ type: "start", shellId: "local", sequence: 2, cwd: "/tmp", command: "empty" }, context);
  store.endCommand({ type: "end", shellId: "local", sequence: 2, cwd: "/tmp", exitCode: 0 });
  store.startCommand({ type: "start", shellId: "local", sequence: 3, cwd: "/tmp", command: "complete" }, context);
  store.appendOutput("complete\n");
  store.endCommand({ type: "end", shellId: "local", sequence: 3, cwd: "/tmp", exitCode: 0 });
  store.startCommand({ type: "start", shellId: "local", sequence: 4, cwd: "/tmp", command: "huge" }, context);
  store.appendOutput("x".repeat(DEFAULT_MAX_BYTES + 1));
  store.endCommand({ type: "end", shellId: "local", sequence: 4, cwd: "/tmp", exitCode: 0 });

  const commands = store.listCommands(10);
  const colored = commands.find((command) => command.command === "colored");
  const empty = commands.find((command) => command.command === "empty");
  const complete = commands.find((command) => command.command === "complete");
  const huge = commands.find((command) => command.command === "huge");
  assert.ok(colored);
  assert.ok(empty);
  assert.ok(complete);
  assert.ok(huge);
  const page = readHistoryPage(store, {
    index: colored.index,
    offset: 2,
    limit: 1,
  });
  assert.deepEqual(page.content, [{
    type: "text",
    text: "two\n\n[1 more line. Use offset=3 to continue.]",
  }]);
  assert.deepEqual(page.details, { totalLines: 3, hasMore: true });

  const emptyResult = readHistoryPage(store, { index: empty.index });
  assert.deepEqual(emptyResult.content, [{ type: "text", text: "(no output)" }]);
  assert.deepEqual(emptyResult.details, { totalLines: 0, hasMore: false });
  const completeResult = readHistoryPage(store, { index: complete.index, limit: 1 });
  assert.deepEqual(completeResult.content, [{ type: "text", text: "complete\n" }]);
  assert.deepEqual(completeResult.details, { totalLines: 1, hasMore: false });
  const hugeResult = readHistoryPage(store, { index: huge.index });
  assert.deepEqual(hugeResult.details, { totalLines: 1, hasMore: false });
  assert.throws(
    () => readHistoryPage(store, { index: colored.index, offset: 99 }),
    /beyond command output/,
  );
  assert.throws(
    () => readHistoryPage(store, { index: 999 }),
    /not found/,
  );
});
