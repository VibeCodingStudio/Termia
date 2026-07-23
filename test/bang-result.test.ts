import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import test from "node:test";
import type { CommandRecord } from "../extensions/termia/history.ts";
import {
  BangExecutionView,
  createBangResultData,
  isBangResultData,
  renderBangResult,
} from "../extensions/termia/bang-result.ts";

const record: CommandRecord = {
  index: 1,
  id: "command",
  terminalSessionId: "terminal",
  shellId: "local",
  command: "printf ok",
  cwd: "/tmp/before",
  workspaceUri: "file:///tmp/before",
  hopChain: [],
  startedAt: 100,
  endedAt: 125,
  exitCode: 0,
  outputStart: 0,
  outputEnd: 4,
  transcriptPath: "/tmp/transcript.log",
};

test("creates sanitized, completed bang result data", () => {
  const data = createBangResultData(
    "printf ok",
    record,
    "/tmp/after",
    "\u001b[31mok\u001b[0m\r\n",
  );

  assert.deepEqual(data, {
    command: "printf ok",
    output: "ok\n",
    exitCode: 0,
    cwd: "/tmp/after",
    durationMs: 25,
    truncated: false,
  });
  assert.equal(isBangResultData(data), true);
});

test("keeps only the bounded tail of large output", () => {
  const output = Array.from({ length: 2_100 }, (_, index) => `line ${index}`).join("\n");
  const data = createBangResultData("many", record, "/tmp", output);

  assert.equal(data.truncated, true);
  assert.doesNotMatch(data.output, /line 0\n/);
  assert.match(data.output, /line 2099$/);
});

test("validates every persisted result field", () => {
  assert.equal(isBangResultData(null), false);
  assert.equal(isBangResultData({ command: 1 }), false);
  assert.equal(
    isBangResultData({
      command: "pwd",
      output: "",
      exitCode: 0,
      cwd: "/tmp",
      durationMs: -1,
      truncated: false,
    }),
    false,
  );
});

test("rejects incomplete command records", () => {
  assert.throws(
    () => createBangResultData("pwd", { ...record, exitCode: null }, "/tmp", ""),
    /completed command/,
  );
  assert.throws(
    () => createBangResultData("pwd", { ...record, endedAt: null }, "/tmp", ""),
    /completed command/,
  );
});

test("renders the persisted result and a bounded interruptible live view", () => {
  const theme: Pick<Theme, "fg"> = { fg: (_color, text) => text };
  const data = createBangResultData("printf ok", record, "/tmp/after", "ok\n");
  const persisted = stripVTControlCharacters(renderBangResult(data, theme).render(80).join("\n"));
  assert.match(persisted, /\$ printf ok/);
  assert.match(persisted, /exit 0 · 25ms · \/tmp\/after/);

  let aborts = 0;
  const view = new BangExecutionView("many", theme, () => {
    aborts += 1;
  });
  view.append(`${Array.from({ length: 25 }, (_, index) => `line ${index}`).join("\r\n")}\r\n`);
  const live = stripVTControlCharacters(view.render(80).join("\n"));
  assert.doesNotMatch(live, /line 0\b/);
  assert.match(live, /line 24\b/);
  view.handleInput("\u001b");
  view.handleInput("\u001b");
  assert.equal(aborts, 1);
});
