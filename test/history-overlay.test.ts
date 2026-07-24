import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { CommandRecord, HistoryStore } from "../extensions/termia/history.ts";
import {
  formatHistoryContext,
  formatHistoryPaste,
  HistoryOverlay,
  HistoryOverlayModel,
  registerHistoryCommand,
} from "../extensions/termia/history-overlay.ts";

const commands: CommandRecord[] = [
  {
    index: 2,
    id: "new",
    terminalSessionId: "terminal",
    shellId: "host-b",
    command: "printf new",
    cwd: "/tmp/new",
    workspaceUri: "ssh://host-b/tmp/new",
    hopChain: ["host-a", "host-b"],
    startedAt: 20,
    endedAt: 25,
    exitCode: 0,
    outputStart: 0,
    outputEnd: 3,
    transcriptPath: "/tmp/new.log",
  },
  {
    index: 1,
    id: "old",
    terminalSessionId: "terminal",
    shellId: "local",
    command: "printf old",
    cwd: "/tmp/old",
    workspaceUri: "file:///tmp/old",
    hopChain: [],
    startedAt: 10,
    endedAt: 15,
    exitCode: 1,
    outputStart: 3,
    outputEnd: 6,
    transcriptPath: "/tmp/old.log",
  },
];

const theme: Pick<Theme, "fg" | "bg"> = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
};

test("registers /history only for an enabled Termia session", () => {
  const registered: string[] = [];
  const api = {
    registerCommand: (name: string) => registered.push(name),
  } as unknown as Pick<ExtensionAPI, "registerCommand">;
  const store = {} as HistoryStore;

  registerHistoryCommand(api, false, store);
  assert.deepEqual(registered, []);
  registerHistoryCommand(api, true, store);
  assert.deepEqual(registered, ["history"]);
});

test("selects commands in display order and formats metadata without output", () => {
  const outputs = new Map([["old", "\u001b[31mplain text\u001b[0m\r\n"]]);
  const model = new HistoryOverlayModel(commands, (command) => outputs.get(command.id) ?? "");

  assert.equal(model.selectedIndex, 0);
  model.toggleSelection();
  model.handle("down");
  model.toggleSelection();
  model.handle("expand");

  assert.equal(model.selectedIndex, 1);
  assert.equal(model.expanded, true);
  assert.equal(model.output(), "plain text\n");
  assert.deepEqual(model.selection().map((command) => command.index), [2, 1]);

  const context = formatHistoryContext(model.selection());
  assert.match(context, /\[Termia history #2\]/);
  assert.match(context, /command: printf new/);
  assert.match(context, /cwd: \/tmp\/new/);
  assert.match(context, /workspace: ssh:\/\/host-b\/tmp\/new/);
  assert.match(context, /via: host-a -> host-b/);
  assert.match(context, /exit: 0/);
  assert.match(context, /duration: 5ms/);
  assert.doesNotMatch(context, /plain text/);
});

test("uses Space, the configured expand binding, Enter, and Escape", () => {
  const model = new HistoryOverlayModel(commands, (command) => `${command.command} output`);
  let completionCount = 0;
  let completed: CommandRecord[] | undefined;
  const overlay = new HistoryOverlay(
    model,
    theme,
    (data) => data === "expand-key",
    "ctrl+o",
    (result) => {
      completionCount += 1;
      completed = result;
    },
  );

  overlay.handleInput("\r");
  assert.equal(completionCount, 0);
  overlay.handleInput(" ");
  overlay.handleInput("\u001b[B");
  overlay.handleInput("expand-key");
  overlay.handleInput(" ");
  assert.ok(overlay.render(100).some((line) => line.includes("#2 [exit 0] printf new")));
  assert.ok(overlay.render(100).some((line) => line.includes("ssh://host-b/tmp/new · via host-a -> host-b")));
  assert.ok(overlay.render(100).some((line) => line.includes("file:///tmp/old")));
  assert.ok(overlay.render(100).some((line) => line.includes("ctrl+o output")));
  overlay.handleInput("\r");

  assert.equal(model.expanded, true);
  assert.equal(completionCount, 1);
  assert.deepEqual(completed?.map((command) => command.index), [2, 1]);

  const cancelled = new HistoryOverlay(
    model,
    theme,
    () => false,
    "ctrl+o",
    (result) => {
      completionCount += 1;
      completed = result;
    },
  );
  cancelled.handleInput("\u001b");
  assert.equal(completionCount, 2);
  assert.equal(completed, undefined);
});

test("renders multiline commands as one terminal row", () => {
  const model = new HistoryOverlayModel(
    [{ ...commands[0]!, command: "set -euo pipefail\nbase=$HOME\tfor version in 1 2" }],
    () => "",
  );
  const overlay = new HistoryOverlay(model, theme, () => false, "ctrl+o", () => {});
  const lines = overlay.render(100);

  assert.equal(lines.every((line) => !/[\r\n\t]/.test(line)), true);
  assert.ok(lines.some((line) => line.includes("set -euo pipefail base=$HOME for version in 1 2")));
});

test("pads short history context into a native Pi paste without changing submitted text", () => {
  const shortContext = formatHistoryContext([commands[1]!]);
  const shortPaste = formatHistoryPaste([commands[1]!]);
  assert.equal(shortPaste.split("\n").length, 11);
  assert.equal(shortPaste.trimEnd(), shortContext);

  const longContext = formatHistoryContext(commands);
  assert.equal(formatHistoryPaste(commands), longContext);
});
