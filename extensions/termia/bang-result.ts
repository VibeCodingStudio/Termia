import { stripVTControlCharacters } from "node:util";
import {
  truncateTail,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  Text,
  truncateToWidth,
  type Component,
} from "@earendil-works/pi-tui";
import type { CommandRecord } from "./history.ts";

type BangTheme = Pick<Theme, "fg">;

export type BangResultData = {
  command: string;
  output: string;
  exitCode: number;
  cwd: string;
  durationMs: number;
  truncated: boolean;
};

function cleanOutput(output: string): string {
  return stripVTControlCharacters(output).replace(/\r\n?/g, "\n");
}

export function createBangResultData(
  command: string,
  record: CommandRecord,
  finalCwd: string,
  rawOutput: string,
): BangResultData {
  if (record.exitCode === null || record.endedAt === null) {
    throw new Error("Termia bang result requires a completed command");
  }

  const result = truncateTail(cleanOutput(rawOutput));
  return {
    command,
    output: result.content,
    exitCode: record.exitCode,
    cwd: finalCwd,
    durationMs: Math.max(0, record.endedAt - record.startedAt),
    truncated: result.truncated,
  };
}

export function isBangResultData(value: unknown): value is BangResultData {
  if (typeof value !== "object" || value === null) return false;
  const fields = [
    "command",
    "output",
    "exitCode",
    "cwd",
    "durationMs",
    "truncated",
  ];
  if (!fields.every((field) => Object.hasOwn(value, field))) return false;

  const command = Reflect.get(value, "command");
  const output = Reflect.get(value, "output");
  const exitCode = Reflect.get(value, "exitCode");
  const cwd = Reflect.get(value, "cwd");
  const durationMs = Reflect.get(value, "durationMs");
  const truncated = Reflect.get(value, "truncated");
  return (
    typeof command === "string" &&
    command.length > 0 &&
    typeof output === "string" &&
    typeof exitCode === "number" &&
    Number.isSafeInteger(exitCode) &&
    typeof cwd === "string" &&
    cwd.length > 0 &&
    typeof durationMs === "number" &&
    Number.isSafeInteger(durationMs) &&
    durationMs >= 0 &&
    typeof truncated === "boolean"
  );
}

export function renderBangResult(data: BangResultData, theme: BangTheme): Component {
  const output = data.output.endsWith("\n")
    ? data.output.slice(0, -1)
    : data.output;
  const lines = [theme.fg("bashMode", `$ ${data.command}`)];
  if (output.length > 0) lines.push(theme.fg("toolOutput", output));
  const status = `exit ${data.exitCode} · ${data.durationMs}ms · ${data.cwd}`;
  lines.push(theme.fg(data.exitCode === 0 ? "success" : "error", status));
  if (data.truncated) {
    lines.push(theme.fg("dim", "Output truncated · use /history for the full transcript"));
  }
  return new Text(lines.join("\n"));
}

export class BangExecutionView implements Component {
  readonly #command: string;
  readonly #theme: BangTheme;
  readonly #abort: () => void;
  #lines: string[] = [];
  #pending = "";
  #aborted = false;

  constructor(command: string, theme: BangTheme, abort: () => void) {
    this.#command = command;
    this.#theme = theme;
    this.#abort = abort;
  }

  append(data: string): void {
    const chunks = `${this.#pending}${cleanOutput(data)}`.split("\n");
    this.#pending = chunks.pop() ?? "";
    this.#lines.push(...chunks);
    this.#lines = this.#lines.slice(-20);
    if (this.#pending.length > 10_000) this.#pending = this.#pending.slice(-10_000);
  }

  handleInput(data: string): void {
    if (!this.#aborted && matchesKey(data, "escape")) {
      this.#aborted = true;
      this.#abort();
    }
  }

  render(width: number): string[] {
    if (width < 1) return [];
    const output = [...this.#lines, this.#pending].slice(-20);
    return [
      this.#theme.fg("bashMode", `$ ${this.#command}`),
      ...output.map((line) => this.#theme.fg("toolOutput", line)),
      this.#theme.fg("dim", this.#aborted ? "Interrupting…" : "Esc interrupt"),
    ].map((line) => truncateToWidth(line, width));
  }

  invalidate(): void {}
}
