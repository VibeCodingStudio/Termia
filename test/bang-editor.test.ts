import assert from "node:assert/strict";
import test from "node:test";
import type { EditorComponent } from "@earendil-works/pi-tui";
import {
  BangEditor,
  encodeBangSubmission,
  installBangEditor,
  parseTermiaInvocation,
  type EditorFactory,
} from "../extensions/termia/bang-editor.ts";

class FakeEditor implements EditorComponent {
  onSubmit: (text: string) => void = () => {};
  onChange: (text: string) => void = () => {};
  onEscape: (() => void) | undefined;
  onCtrlD: (() => void) | undefined;
  onPasteImage: (() => void) | undefined;
  onExtensionShortcut: ((data: string) => boolean) | undefined;
  readonly actionHandlers = new Map<string, () => void>();
  readonly history: string[] = [];
  readonly inputs: string[] = [];
  private text = "";

  getText(): string {
    return this.text;
  }

  setText(text: string): void {
    this.text = text;
  }

  handleInput(data: string): void {
    this.inputs.push(data);
    if (data === "submit") this.onSubmit?.(this.text);
  }

  addToHistory(text: string): void {
    this.history.push(text);
  }

  render(width: number): string[] {
    return [`width:${width}`];
  }

  invalidate(): void {}
}

test("encodes context and hidden bang submissions", () => {
  const context = encodeBangSubmission("!printf '%s\\n' ok");
  const hidden = encodeBangSubmission("!!printf '%s\\n' a\nb");

  assert.deepEqual(parseTermiaInvocation(context.slice("/termia ".length)), {
    type: "bang",
    command: "printf '%s\\n' ok",
    excludeFromContext: false,
  });
  assert.deepEqual(parseTermiaInvocation(hidden.slice("/termia ".length)), {
    type: "bang",
    command: "printf '%s\\n' a\nb",
    excludeFromContext: true,
  });
});

test("passes ordinary and empty bang submissions through", () => {
  assert.equal(encodeBangSubmission("explain !important"), "explain !important");
  assert.equal(encodeBangSubmission("!"), "!");
  assert.deepEqual(parseTermiaInvocation(""), { type: "terminal" });
  assert.deepEqual(parseTermiaInvocation("__terminal"), { type: "terminal" });
});

test("rejects malformed reserved invocations", () => {
  assert.throws(() => parseTermiaInvocation("__bang hidden invalid="), /Invalid Termia bang command/);
  assert.throws(() => parseTermiaInvocation("unexpected"), /Invalid Termia invocation/);
});

test("wraps submission and restores original editor history", () => {
  const base = new FakeEditor();
  const editor = new BangEditor(base, () => true);
  const submitted: string[] = [];
  editor.onSubmit = (text) => submitted.push(text);
  editor.setText("!!pwd");

  editor.handleInput("submit");
  const transformed = submitted[0];
  assert.ok(transformed);
  editor.addToHistory(transformed);

  assert.deepEqual(parseTermiaInvocation(transformed.slice("/termia ".length)), {
    type: "bang",
    command: "pwd",
    excludeFromContext: true,
  });
  assert.deepEqual(base.history, ["!!pwd"]);
  assert.deepEqual(base.inputs, ["submit"]);
  assert.deepEqual(editor.render(42), ["width:42"]);
});

test("rewrites bang submissions only while Termia mode is enabled", () => {
  const base = new FakeEditor();
  let enabled = false;
  const editor = new BangEditor(base, () => enabled);
  const submitted: string[] = [];
  editor.onSubmit = (text) => submitted.push(text);

  editor.setText("!!pwd");
  editor.handleInput("submit");
  enabled = true;
  editor.handleInput("submit");

  assert.equal(submitted[0], "!!pwd");
  const transformed = submitted[1];
  assert.ok(transformed);
  assert.deepEqual(parseTermiaInvocation(transformed.slice("/termia ".length)), {
    type: "bang",
    command: "pwd",
    excludeFromContext: true,
  });
});

test("uses Ctrl+] to enter the PTY only in Termia mode and preserves the draft", () => {
  const base = new FakeEditor();
  let enabled = false;
  const drafts: string[] = [];
  const editor = new BangEditor(base, () => enabled, (draft) => drafts.push(draft));
  const submitted: string[] = [];
  editor.onSubmit = (text) => submitted.push(text);
  editor.setText("unfinished prompt");

  editor.handleInput("\x1d");
  enabled = true;
  editor.handleInput("\x1d");

  assert.deepEqual(base.inputs, ["\x1d"]);
  assert.deepEqual(drafts, ["unfinished prompt"]);
  assert.deepEqual(submitted, ["/termia __terminal"]);
  assert.equal(editor.getText(), "unfinished prompt");
  editor.addToHistory("/termia __terminal");
  assert.deepEqual(base.history, []);
});

test("exposes Pi app handlers from the wrapped editor", () => {
  const base = new FakeEditor();
  const editor = new BangEditor(base, () => true);
  let escapes = 0;
  let exits = 0;
  let pasted = 0;
  const escape = () => {
    escapes += 1;
  };
  const exit = () => {
    exits += 1;
  };
  const paste = () => {
    pasted += 1;
  };
  const shortcut = (data: string) => data === "shortcut";

  assert.equal(editor.actionHandlers, base.actionHandlers);
  editor.onEscape = escape;
  editor.onCtrlD = exit;
  editor.onPasteImage = paste;
  editor.onExtensionShortcut = shortcut;
  assert.equal(base.onEscape, escape);
  assert.equal(base.onCtrlD, exit);
  assert.equal(base.onPasteImage, paste);
  assert.equal(base.onExtensionShortcut, shortcut);
  editor.onEscape?.();
  editor.onCtrlD?.();
  editor.onPasteImage?.();
  assert.equal(escapes, 1);
  assert.equal(exits, 1);
  assert.equal(pasted, 1);
  assert.equal(editor.onExtensionShortcut?.("shortcut"), true);
  assert.equal(editor.onExtensionShortcut?.("ordinary"), false);
});

test("installs over the default editor once", () => {
  let current: EditorFactory | undefined;
  let installs = 0;
  const ui = {
    getEditorComponent: () => current,
    setEditorComponent: (factory: EditorFactory | undefined) => {
      installs += 1;
      current = factory;
    },
  };

  const installed = installBangEditor(ui, undefined, () => true);
  assert.equal(current, installed);
  assert.equal(installBangEditor(ui, installed, () => true), installed);
  assert.equal(installs, 1);
});
