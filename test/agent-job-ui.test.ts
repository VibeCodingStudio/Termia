import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  AgentJobSelector,
  AgentJobSelectorModel,
  type AgentJobView,
} from "../extensions/termia/agent-job-ui.ts";

const theme: Pick<Theme, "fg" | "bg"> = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
};

const jobs: AgentJobView[] = [
  { id: 7, command: "sudo apt update", cwd: "/srv", startedAt: 1, status: "waiting" },
  { id: 8, command: "read answer", cwd: "/srv", startedAt: 2, status: "waiting" },
];

test("keeps Agent job selection stable as jobs update", () => {
  const model = new AgentJobSelectorModel(jobs);
  assert.equal(model.selected()?.id, 7);
  model.move(1);
  assert.equal(model.selected()?.id, 8);
  model.move(1);
  assert.equal(model.selected()?.id, 8);

  model.replace([{ ...jobs[1]!, status: "running" }, { ...jobs[0]!, status: "waiting" }]);
  assert.equal(model.selected()?.id, 8);
  model.replace([{ ...jobs[0]!, status: "waiting" }]);
  assert.equal(model.selected()?.id, 7);
  model.move(-1);
  assert.equal(model.selected()?.id, 7);
});

test("selects a waiting Agent job without handling Ctrl+] or Escape", () => {
  const selected: number[] = [];
  const model = new AgentJobSelectorModel(jobs);
  const view = new AgentJobSelector(model, theme, (id) => selected.push(id));

  view.handleInput("\u001b[B");
  view.handleInput("\x1d");
  view.handleInput("\u001b");
  assert.deepEqual(selected, []);
  view.handleInput("\r");
  assert.deepEqual(selected, [8]);
  const rendered = view.render(80).join("\n");
  assert.match(rendered, /read answer/);
  assert.match(rendered, /Ctrl\+G job menu/);
  assert.match(rendered, /Ctrl\+\] unavailable while Agent runs/);
});

test("renders control whitespace on one bounded row", () => {
  const model = new AgentJobSelectorModel([
    { ...jobs[0]!, command: "printf one\nread\tanswer\u001b[31m" },
  ]);
  const view = new AgentJobSelector(model, theme, () => {});
  const lines = view.render(48);
  assert.equal(lines.every((line) => !/[\r\n\t]/.test(line)), true);
  assert.equal(lines.every((line) => visibleWidth(line) <= 48), true);
});
