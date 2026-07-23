import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { CommandRecord } from "./history.ts";

type HistoryAction = "up" | "down" | "expand";
type HistoryTheme = Pick<Theme, "fg" | "bg">;

function formatCommandContext(command: CommandRecord): string {
  const running = command.endedAt === null;
  const exit = command.exitCode === null ? "running" : String(command.exitCode);
  const duration = command.endedAt === null
    ? "running"
    : `${command.endedAt - command.startedAt}ms`;
  return [
    `[Termia history #${command.index}]`,
    `command: ${command.command}`,
    `status: ${running ? "running" : "completed"}`,
    `workspace: ${command.workspaceUri}`,
    ...(command.hopChain.length === 0 ? [] : [`via: ${command.hopChain.join(" -> ")}`]),
    `cwd: ${command.cwd}`,
    `exit: ${exit}`,
    `started: ${new Date(command.startedAt).toISOString()}`,
    `duration: ${duration}`,
  ].join("\n");
}

export function formatHistoryContext(commands: CommandRecord[]): string {
  return commands.map(formatCommandContext).join("\n\n");
}

export function formatHistoryPaste(commands: CommandRecord[]): string {
  const context = formatHistoryContext(commands);
  const lineCount = context.split("\n").length;
  return lineCount > 10 ? context : `${context}${"\n".repeat(11 - lineCount)}`;
}

export class HistoryOverlayModel {
  readonly commands: CommandRecord[];
  selectedIndex = 0;
  expanded = false;
  private readonly readOutput: (command: CommandRecord) => string;
  private readonly selectedIndexes = new Set<number>();

  constructor(
    commands: CommandRecord[],
    readOutput: (command: CommandRecord) => string,
  ) {
    this.commands = commands;
    this.readOutput = readOutput;
  }

  get selected(): CommandRecord | undefined {
    return this.commands[this.selectedIndex];
  }

  isSelected(command: CommandRecord): boolean {
    return this.selectedIndexes.has(command.index);
  }

  toggleSelection(): void {
    const command = this.selected;
    if (command === undefined) return;
    if (this.selectedIndexes.has(command.index)) this.selectedIndexes.delete(command.index);
    else this.selectedIndexes.add(command.index);
  }

  selection(): CommandRecord[] {
    return this.commands.filter((command) => this.selectedIndexes.has(command.index));
  }

  handle(action: HistoryAction): void {
    if (action === "up") this.selectedIndex = Math.max(0, this.selectedIndex - 1);
    if (action === "down") this.selectedIndex = Math.min(this.commands.length - 1, this.selectedIndex + 1);
    if (action === "expand" && this.selected !== undefined) this.expanded = !this.expanded;
  }

  output(): string {
    const command = this.selected;
    return command === undefined
      ? ""
      : stripVTControlCharacters(this.readOutput(command)).replace(/\r\n?/g, "\n");
  }
}

export class HistoryOverlay implements Component {
  private readonly model: HistoryOverlayModel;
  private readonly theme: HistoryTheme;
  private readonly matchesExpand: (data: string) => boolean;
  private readonly expandKey: string;
  private readonly finish: (commands: CommandRecord[] | undefined) => void;

  constructor(
    model: HistoryOverlayModel,
    theme: HistoryTheme,
    matchesExpand: (data: string) => boolean,
    expandKey: string,
    finish: (commands: CommandRecord[] | undefined) => void,
  ) {
    this.model = model;
    this.theme = theme;
    this.matchesExpand = matchesExpand;
    this.expandKey = expandKey.length === 0 ? "expand" : expandKey;
    this.finish = finish;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.finish(undefined);
      return;
    }
    if (matchesKey(data, "up")) {
      this.model.handle("up");
    } else if (matchesKey(data, "down")) {
      this.model.handle("down");
    } else if (matchesKey(data, "space")) {
      this.model.toggleSelection();
    } else if (this.matchesExpand(data)) {
      this.model.handle("expand");
    } else if (matchesKey(data, "return")) {
      const selection = this.model.selection();
      if (selection.length > 0) this.finish(selection);
    }
  }

  render(width: number): string[] {
    if (width < 4) return [truncateToWidth("Termia history", width)];
    const innerWidth = width - 2;
    const row = (content: string) => {
      const clipped = truncateToWidth(content.replace(/[\t\n\v\f\r]+/g, " "), innerWidth);
      const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
      return `${this.theme.fg("border", "│")}${clipped}${padding}${this.theme.fg("border", "│")}`;
    };
    const lines = [
      this.theme.fg("border", `╭${"─".repeat(innerWidth)}╮`),
      row(` ${this.theme.fg("accent", "Termia command history")}`),
    ];

    const listHeight = 8;
    const start = Math.max(0, Math.min(this.model.selectedIndex, this.model.commands.length - listHeight));
    let workspaceUri: string | undefined;
    for (let index = start; index < Math.min(start + listHeight, this.model.commands.length); index += 1) {
      const command = this.model.commands[index];
      if (command === undefined) continue;
      if (command.workspaceUri !== workspaceUri) {
        const via = command.hopChain.length === 0 ? "" : ` · via ${command.hopChain.join(" -> ")}`;
        lines.push(row(` ${this.theme.fg("dim", `${command.workspaceUri}${via}`)}`));
        workspaceUri = command.workspaceUri;
      }
      const active = index === this.model.selectedIndex;
      const checked = this.model.isSelected(command) ? "[x]" : "[ ]";
      const exit = command.exitCode === null ? "running" : String(command.exitCode);
      const content = ` ${checked} ${active ? "▶" : " "} #${command.index} [exit ${exit}] ${command.command}`;
      lines.push(row(active ? this.theme.bg("selectedBg", content) : content));
    }

    const selected = this.model.selected;
    if (selected !== undefined) {
      const duration = selected.endedAt === null ? "running" : `${selected.endedAt - selected.startedAt}ms`;
      lines.push(row(""));
      lines.push(row(` workspace: ${selected.workspaceUri}`));
      lines.push(row(` cwd: ${selected.cwd}`));
      lines.push(row(` time: ${new Date(selected.startedAt).toLocaleString()} · duration: ${duration}`));
      if (this.model.expanded) {
        const outputLines = this.model.output().split("\n");
        lines.push(row(` ${this.theme.fg("dim", "output")}`));
        for (const outputLine of outputLines.slice(0, 10)) lines.push(row(` ${outputLine}`));
        if (outputLines.length > 10) lines.push(row(` ${this.theme.fg("dim", `… ${outputLines.length - 10} more lines`)}`));
      }
    }

    const controls = `↑↓ move · Space select · ${this.expandKey} output · Enter use · Esc close`;
    lines.push(row(` ${this.theme.fg("dim", controls)}`));
    lines.push(this.theme.fg("border", `╰${"─".repeat(innerWidth)}╯`));
    return lines;
  }

  invalidate(): void {}
}
