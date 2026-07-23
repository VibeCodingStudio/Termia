import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import {
  termiaRoot,
  withTermiaHistoryTool,
} from "../extensions/termia/mode.ts";

test("derives the complete Termia root from Pi's agent directory", () => {
  assert.equal(termiaRoot("/tmp/pi-agent"), resolve("/tmp/pi-agent", "termia"));
});

test("changes only termia_history in Pi's active tools", () => {
  assert.deepEqual(
    withTermiaHistoryTool(["read", "termia_history", "bash"], false),
    ["read", "bash"],
  );
  assert.deepEqual(
    withTermiaHistoryTool(["read", "bash"], true),
    ["read", "bash", "termia_history"],
  );
  assert.deepEqual(
    withTermiaHistoryTool(["read", "termia_history", "bash", "termia_history"], true),
    ["read", "termia_history", "bash"],
  );
});
