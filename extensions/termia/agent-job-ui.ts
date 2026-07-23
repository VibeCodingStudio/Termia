import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

export type AgentJobView = {
  id: number;
  command: string;
  cwd: string;
  startedAt: number;
  status: "running" | "waiting" | "foreground";
};

type AgentJobTheme = Pick<Theme, "fg" | "bg">;

export class AgentJobSelectorModel {
  private jobs: AgentJobView[];
  private selectedId: number | undefined;

  constructor(jobs: AgentJobView[]) {
    this.jobs = jobs;
    this.selectedId = jobs[0]?.id;
  }

  selected(): AgentJobView | undefined {
    return this.jobs.find((job) => job.id === this.selectedId);
  }

  replace(jobs: AgentJobView[]): void {
    this.jobs = jobs;
    if (!jobs.some((job) => job.id === this.selectedId)) this.selectedId = jobs[0]?.id;
  }

  move(delta: -1 | 1): void {
    const index = Math.max(0, this.jobs.findIndex((job) => job.id === this.selectedId));
    const next = Math.max(0, Math.min(this.jobs.length - 1, index + delta));
    this.selectedId = this.jobs[next]?.id;
  }

  list(): readonly AgentJobView[] {
    return this.jobs;
  }
}

export class AgentJobSelector implements Component {
  private readonly model: AgentJobSelectorModel;
  private readonly theme: AgentJobTheme;
  private readonly finish: (jobId: number) => void;

  constructor(
    model: AgentJobSelectorModel,
    theme: AgentJobTheme,
    finish: (jobId: number) => void,
  ) {
    this.model = model;
    this.theme = theme;
    this.finish = finish;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "up")) this.model.move(-1);
    else if (matchesKey(data, "down")) this.model.move(1);
    else if (matchesKey(data, "return")) {
      const selected = this.model.selected();
      if (selected !== undefined) this.finish(selected.id);
    }
  }

  render(width: number): string[] {
    if (width < 4) return [truncateToWidth("Agent jobs", width)];
    const innerWidth = width - 2;
    const row = (content: string) => {
      const clean = stripVTControlCharacters(content).replace(/[\t\n\v\f\r]+/g, " ");
      const clipped = truncateToWidth(clean, innerWidth);
      return `${this.theme.fg("border", "│")}${clipped}${" ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)))}${this.theme.fg("border", "│")}`;
    };
    const selectedId = this.model.selected()?.id;
    const lines = [
      this.theme.fg("border", `╭${"─".repeat(innerWidth)}╮`),
      row(` ${this.theme.fg("accent", "Agent commands waiting for input")}`),
    ];
    for (const job of this.model.list()) {
      const content = ` ${job.id === selectedId ? "▶" : " "} #${job.id} [${job.status}] ${job.command}`;
      lines.push(row(job.id === selectedId ? this.theme.bg("selectedBg", content) : content));
    }
    lines.push(row(` ${this.theme.fg("dim", "↑↓ move · Enter open · Ctrl+G job menu · Ctrl+] unavailable while Agent runs")}`));
    lines.push(this.theme.fg("border", `╰${"─".repeat(innerWidth)}╯`));
    return lines;
  }

  invalidate(): void {}
}
