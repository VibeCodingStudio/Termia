import {
  CustomEditor,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type {
  AutocompleteProvider,
  EditorComponent,
} from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";

export type TermiaInvocation =
  | { type: "terminal" }
  | {
      type: "bang";
      command: string;
      excludeFromContext: boolean;
    };

export type EditorFactory = NonNullable<
  ReturnType<ExtensionUIContext["getEditorComponent"]>
>;
type EditorInstallationUI = Pick<
  ExtensionUIContext,
  "getEditorComponent" | "setEditorComponent"
>;

const BANG_PREFIX = "__bang";
const TERMINAL_INVOCATION = "__terminal";

function voidHandler(
  editor: EditorComponent,
  property: string,
): (() => void) | undefined {
  const value: unknown = Reflect.get(editor, property);
  return typeof value === "function"
    ? () => {
        Reflect.apply(value, editor, []);
      }
    : undefined;
}

function inputHandler(
  editor: EditorComponent,
  property: string,
): ((data: string) => boolean) | undefined {
  const value: unknown = Reflect.get(editor, property);
  return typeof value === "function"
    ? (data) => Reflect.apply(value, editor, [data]) === true
    : undefined;
}

function setEditorProperty(
  editor: EditorComponent,
  property: string,
  value: unknown,
): void {
  Reflect.set(editor, property, value);
}

export function encodeBangSubmission(text: string): string {
  if (!text.startsWith("!")) {
    return text;
  }

  const excludeFromContext = text.startsWith("!!");
  const command = text.slice(excludeFromContext ? 2 : 1).trim();
  if (command.length === 0) {
    return text;
  }

  const mode = excludeFromContext ? "hidden" : "context";
  const payload = Buffer.from(command, "utf8").toString("base64url");
  return `/termia ${BANG_PREFIX} ${mode} ${payload}`;
}

export function parseTermiaInvocation(args: string): TermiaInvocation {
  const invocation = args.trim();
  if (invocation.length === 0) {
    return { type: "terminal" };
  }
  if (invocation === TERMINAL_INVOCATION) {
    return { type: "terminal" };
  }

  if (!invocation.startsWith(BANG_PREFIX)) {
    throw new Error("Invalid Termia invocation");
  }

  const match = /^__bang (context|hidden) ([A-Za-z0-9_-]+)$/.exec(invocation);
  if (match === null) {
    throw new Error("Invalid Termia bang command");
  }

  const mode = match[1];
  const payload = match[2];
  if (mode === undefined || payload === undefined) {
    throw new Error("Invalid Termia bang command");
  }

  const bytes = Buffer.from(payload, "base64url");
  const command = bytes.toString("utf8");
  if (
    command.length === 0 ||
    bytes.toString("base64url") !== payload ||
    !Buffer.from(command, "utf8").equals(bytes)
  ) {
    throw new Error("Invalid Termia bang command");
  }

  return {
    type: "bang",
    command,
    excludeFromContext: mode === "hidden",
  };
}

function restoreBangSubmission(text: string): string | undefined {
  if (text === `/termia ${TERMINAL_INVOCATION}`) return undefined;
  const prefix = "/termia ";
  if (!text.startsWith(prefix)) {
    return text;
  }

  try {
    const invocation = parseTermiaInvocation(text.slice(prefix.length));
    if (invocation.type === "bang") {
      return `${invocation.excludeFromContext ? "!!" : "!"}${invocation.command}`;
    }
  } catch {
    return text;
  }

  return text;
}

export class BangEditor implements EditorComponent {
  readonly #base: EditorComponent;
  readonly #enabled: () => boolean;
  readonly #onTerminalShortcut: (draft: string) => void;
  #onSubmit: (text: string) => void = () => {};
  #onChange: (text: string) => void = () => {};

  constructor(
    base: EditorComponent,
    enabled: () => boolean,
    onTerminalShortcut: (draft: string) => void = () => {},
  ) {
    this.#base = base;
    this.#enabled = enabled;
    this.#onTerminalShortcut = onTerminalShortcut;
  }

  get onSubmit(): (text: string) => void {
    return this.#onSubmit;
  }

  set onSubmit(handler: (text: string) => void) {
    this.#onSubmit = handler;
    this.#base.onSubmit = (text) => handler(
      this.#enabled() ? encodeBangSubmission(text) : text,
    );
  }

  get onChange(): (text: string) => void {
    return this.#onChange;
  }

  set onChange(handler: (text: string) => void) {
    this.#onChange = handler;
    this.#base.onChange = handler;
  }

  get borderColor(): (text: string) => string {
    return this.#base.borderColor ?? ((text) => text);
  }

  set borderColor(color: (text: string) => string) {
    this.#base.borderColor = color;
  }

  get wantsKeyRelease(): boolean {
    return this.#base.wantsKeyRelease ?? false;
  }

  set wantsKeyRelease(value: boolean) {
    this.#base.wantsKeyRelease = value;
  }

  get actionHandlers(): Map<unknown, unknown> | undefined {
    const handlers: unknown = Reflect.get(this.#base, "actionHandlers");
    return handlers instanceof Map ? handlers : undefined;
  }

  get onEscape(): (() => void) | undefined {
    return voidHandler(this.#base, "onEscape");
  }

  set onEscape(handler: (() => void) | undefined) {
    setEditorProperty(this.#base, "onEscape", handler);
  }

  get onCtrlD(): (() => void) | undefined {
    return voidHandler(this.#base, "onCtrlD");
  }

  set onCtrlD(handler: (() => void) | undefined) {
    setEditorProperty(this.#base, "onCtrlD", handler);
  }

  get onPasteImage(): (() => void) | undefined {
    return voidHandler(this.#base, "onPasteImage");
  }

  set onPasteImage(handler: (() => void) | undefined) {
    setEditorProperty(this.#base, "onPasteImage", handler);
  }

  get onExtensionShortcut(): ((data: string) => boolean) | undefined {
    return inputHandler(this.#base, "onExtensionShortcut");
  }

  set onExtensionShortcut(handler: ((data: string) => boolean) | undefined) {
    setEditorProperty(this.#base, "onExtensionShortcut", handler);
  }

  getText(): string {
    return this.#base.getText();
  }

  setText(text: string): void {
    this.#base.setText(text);
  }

  handleInput(data: string): void {
    if (this.#enabled() && matchesKey(data, "ctrl+]")) {
      this.#onTerminalShortcut(this.#base.getText());
      this.#onSubmit(`/termia ${TERMINAL_INVOCATION}`);
      return;
    }
    this.#base.handleInput(data);
  }

  render(width: number): string[] {
    return this.#base.render(width);
  }

  invalidate(): void {
    this.#base.invalidate();
  }

  addToHistory(text: string): void {
    const restored = restoreBangSubmission(text);
    if (restored !== undefined) this.#base.addToHistory?.(restored);
  }

  insertTextAtCursor(text: string): void {
    this.#base.insertTextAtCursor?.(text);
  }

  getExpandedText(): string {
    return this.#base.getExpandedText?.() ?? this.#base.getText();
  }

  setAutocompleteProvider(provider: AutocompleteProvider): void {
    this.#base.setAutocompleteProvider?.(provider);
  }

  setPaddingX(padding: number): void {
    this.#base.setPaddingX?.(padding);
  }

  setAutocompleteMaxVisible(max: number): void {
    this.#base.setAutocompleteMaxVisible?.(max);
  }
}

export function createBangEditorFactory(
  previous: EditorFactory | undefined,
  enabled: () => boolean,
  onTerminalShortcut: (draft: string) => void = () => {},
): EditorFactory {
  return (tui, theme, keybindings) =>
    new BangEditor(
      previous === undefined
        ? new CustomEditor(tui, theme, keybindings)
        : previous(tui, theme, keybindings),
      enabled,
      onTerminalShortcut,
    );
}

export function installBangEditor(
  ui: EditorInstallationUI,
  installed: EditorFactory | undefined,
  enabled: () => boolean,
  onTerminalShortcut: (draft: string) => void = () => {},
): EditorFactory {
  const current = ui.getEditorComponent();
  if (installed !== undefined && current === installed) return installed;
  const factory = createBangEditorFactory(current, enabled, onTerminalShortcut);
  ui.setEditorComponent(factory);
  return factory;
}
