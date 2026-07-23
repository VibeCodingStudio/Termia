import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import type { CommandEndEvent, CommandObservedEvent, CommandStartEvent } from "./protocol.ts";
import type { WorkspaceContext } from "./ssh-workspace.ts";

export type CommandRecord = {
  index: number;
  id: string;
  terminalSessionId: string;
  shellId: string;
  command: string;
  cwd: string;
  workspaceUri: string;
  hopChain: string[];
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  outputStart: number;
  outputEnd: number | null;
  transcriptPath: string;
};

type SqlStatement = ReturnType<DatabaseSync["prepare"]>;
type SqlRow = ReturnType<SqlStatement["all"]>[number];
type ActiveTerminal = { id: string; transcriptPath: string; offset: number };

function commandKey(shellId: string, sequence: number): string {
  return `${shellId}\0${sequence}`;
}

function stringColumn(row: SqlRow, name: string): string {
  const value = row[name];
  if (typeof value !== "string") throw new Error(`Invalid ${name} in Termia history`);
  return value;
}

function numberColumn(row: SqlRow, name: string): number {
  const value = row[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`Invalid ${name} in Termia history`);
  }
  return value;
}

function nullableNumberColumn(row: SqlRow, name: string): number | null {
  const value = row[name];
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`Invalid ${name} in Termia history`);
  }
  return value;
}

function commandRecord(row: SqlRow): CommandRecord {
  const cwd = stringColumn(row, "cwd");
  const workspace = stringColumn(row, "workspaceUri");
  const hopChainValue: unknown = JSON.parse(stringColumn(row, "hopChain"));
  if (!Array.isArray(hopChainValue) || !hopChainValue.every((value) => typeof value === "string")) {
    throw new Error("Invalid hopChain in Termia history");
  }
  return {
    index: numberColumn(row, "historyIndex"),
    id: stringColumn(row, "id"),
    terminalSessionId: stringColumn(row, "terminalSessionId"),
    shellId: stringColumn(row, "shellId"),
    command: stringColumn(row, "command"),
    cwd,
    workspaceUri: workspace.length === 0 ? pathToFileURL(cwd).href : workspace,
    hopChain: hopChainValue,
    startedAt: numberColumn(row, "startedAt"),
    endedAt: nullableNumberColumn(row, "endedAt"),
    exitCode: nullableNumberColumn(row, "exitCode"),
    outputStart: numberColumn(row, "outputStart"),
    outputEnd: nullableNumberColumn(row, "outputEnd"),
    transcriptPath: stringColumn(row, "transcriptPath"),
  };
}

export class HistoryStore {
  private readonly database: DatabaseSync;
  private readonly transcriptRoot: string;
  private readonly activeCommands = new Map<string, string>();
  private activeTerminal: ActiveTerminal | undefined;

  constructor(root: string) {
    mkdirSync(root, { recursive: true });
    this.transcriptRoot = resolve(root, "transcripts");
    mkdirSync(this.transcriptRoot, { recursive: true });
    this.database = new DatabaseSync(join(root, "history.db"));
    this.database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS terminal_sessions (
        id TEXT PRIMARY KEY,
        shell TEXT NOT NULL,
        initial_cwd TEXT NOT NULL,
        transcript_path TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER
      ) STRICT;
      CREATE TABLE IF NOT EXISTS commands (
        id TEXT PRIMARY KEY,
        terminal_session_id TEXT NOT NULL REFERENCES terminal_sessions(id),
        command TEXT NOT NULL,
        cwd TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        exit_code INTEGER,
        output_start INTEGER NOT NULL,
        output_end INTEGER,
        shell_id TEXT NOT NULL DEFAULT 'local',
        workspace_uri TEXT NOT NULL DEFAULT '',
        hop_chain TEXT NOT NULL DEFAULT '[]'
      ) STRICT;
    `);
    const columns = new Set(
      this.database.prepare("PRAGMA table_info(commands)").all().map((row) => stringColumn(row, "name")),
    );
    if (!columns.has("shell_id")) {
      this.database.exec("ALTER TABLE commands ADD COLUMN shell_id TEXT NOT NULL DEFAULT 'local'");
    }
    if (!columns.has("workspace_uri")) {
      this.database.exec("ALTER TABLE commands ADD COLUMN workspace_uri TEXT NOT NULL DEFAULT ''");
    }
    if (!columns.has("hop_chain")) {
      this.database.exec("ALTER TABLE commands ADD COLUMN hop_chain TEXT NOT NULL DEFAULT '[]'");
    }
  }

  startTerminal(input: { id: string; shell: string; cwd: string; startedAt?: number }): void {
    if (this.activeTerminal !== undefined) throw new Error("A Termia terminal is already active");
    if (!/^[A-Za-z0-9_-]+$/.test(input.id)) throw new Error("Invalid Termia terminal id");

    const transcriptPath = join(this.transcriptRoot, `${input.id}.log`);
    writeFileSync(transcriptPath, "", { flag: "wx" });
    this.database.prepare(`
      INSERT INTO terminal_sessions (id, shell, initial_cwd, transcript_path, started_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(input.id, input.shell, input.cwd, transcriptPath, input.startedAt ?? Date.now());
    this.activeTerminal = { id: input.id, transcriptPath, offset: 0 };
  }

  appendOutput(data: string): void {
    const terminal = this.requireTerminal();
    appendFileSync(terminal.transcriptPath, data);
    terminal.offset += Buffer.byteLength(data);
  }

  get outputOffset(): number {
    return this.requireTerminal().offset;
  }

  startCommand(
    event: CommandStartEvent,
    context: WorkspaceContext,
    startedAt = Date.now(),
  ): void {
    const terminal = this.requireTerminal();
    const key = commandKey(event.shellId, event.sequence);
    if (this.activeCommands.has(key)) return;

    const id = randomUUID();
    this.database.prepare(`
      INSERT INTO commands (
        id, terminal_session_id, shell_id, command, cwd, workspace_uri, hop_chain,
        started_at, output_start
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      terminal.id,
      event.shellId,
      event.command,
      event.cwd,
      context.workspaceUri,
      JSON.stringify(context.hopChain),
      startedAt,
      terminal.offset,
    );
    this.activeCommands.set(key, id);
  }

  discardActiveCommand(shellId: string): void {
    const prefix = `${shellId}\0`;
    const remove = this.database.prepare("DELETE FROM commands WHERE id = ?");
    for (const [key, id] of this.activeCommands) {
      if (!key.startsWith(prefix)) continue;
      remove.run(id);
      this.activeCommands.delete(key);
    }
  }

  endCommand(event: CommandEndEvent, endedAt = Date.now()): CommandRecord | undefined {
    const key = commandKey(event.shellId, event.sequence);
    const id = this.activeCommands.get(key);
    if (id === undefined) return undefined;

    const terminal = this.requireTerminal();
    this.database.prepare(`
      UPDATE commands
      SET ended_at = ?, exit_code = ?, output_end = ?
      WHERE id = ?
    `).run(endedAt, event.exitCode, terminal.offset, id);
    this.activeCommands.delete(key);
    const row = this.commandStatement("WHERE commands.id = ?").get(id);
    return row === undefined ? undefined : commandRecord(row);
  }

  recordObservedCommand(
    event: CommandObservedEvent,
    context: WorkspaceContext,
    boundary: { cwd: string; outputOffset: number },
    startedAt = Date.now(),
    endedAt = Date.now(),
  ): CommandRecord {
    const terminal = this.requireTerminal();
    if (
      !Number.isSafeInteger(boundary.outputOffset)
      || boundary.outputOffset < 0
      || boundary.outputOffset > terminal.offset
    ) throw new Error("Invalid observed command output boundary");

    const transcript = readFileSync(terminal.transcriptPath);
    let outputStart = boundary.outputOffset;
    let remainingEchoLines = event.command.split("\n").length;
    // ponytail: ash reports only after execution, so skip its echoed input by line count;
    // add screen-aware parsing only if edited multiline input proves inaccurate.
    while (remainingEchoLines > 0) {
      const newline = transcript.indexOf(0x0a, outputStart);
      if (newline < 0 || newline >= terminal.offset) {
        outputStart = boundary.outputOffset;
        break;
      }
      outputStart = newline + 1;
      remainingEchoLines -= 1;
    }

    const id = randomUUID();
    this.database.prepare(`
      INSERT INTO commands (
        id, terminal_session_id, shell_id, command, cwd, workspace_uri, hop_chain,
        started_at, ended_at, exit_code, output_start, output_end
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      terminal.id,
      event.shellId,
      event.command,
      boundary.cwd,
      context.workspaceUri,
      JSON.stringify(context.hopChain),
      startedAt,
      endedAt,
      event.exitCode,
      outputStart,
      terminal.offset,
    );
    const row = this.commandStatement("WHERE commands.id = ?").get(id);
    if (row === undefined) throw new Error("Failed to record observed Termia command");
    return commandRecord(row);
  }

  listCommands(limit = 200): CommandRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("History limit must be a positive integer");
    return this.commandStatement("ORDER BY commands.started_at DESC LIMIT ?").all(limit).map(commandRecord);
  }

  listCompletedCommands(limit = 200): CommandRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("History limit must be a positive integer");
    return this.commandStatement(
      "WHERE commands.ended_at IS NOT NULL ORDER BY commands.started_at DESC LIMIT ?",
    ).all(limit).map(commandRecord);
  }

  getCommand(index: number): CommandRecord | undefined {
    if (!Number.isSafeInteger(index) || index < 1) {
      throw new Error("History index must be a positive integer");
    }
    const row = this.commandStatement("WHERE commands.rowid = ?").get(index);
    return row === undefined ? undefined : commandRecord(row);
  }

  readOutput(command: CommandRecord): string {
    const transcriptPath = resolve(command.transcriptPath);
    const location = relative(this.transcriptRoot, transcriptPath);
    if (location === "" || location.startsWith("..") || isAbsolute(location)) {
      throw new Error("Command transcript is outside the Termia transcripts directory");
    }

    const data = readFileSync(transcriptPath);
    const end = command.outputEnd ?? data.length;
    if (command.outputStart < 0 || end < command.outputStart || end > data.length) {
      throw new Error("Invalid transcript byte range in Termia history");
    }
    return data.subarray(command.outputStart, end).toString("utf8");
  }

  endTerminal(endedAt = Date.now()): void {
    const terminal = this.activeTerminal;
    if (terminal === undefined) return;

    const updateCommand = this.database.prepare(`
      UPDATE commands SET ended_at = ?, output_end = ? WHERE id = ? AND ended_at IS NULL
    `);
    for (const id of this.activeCommands.values()) updateCommand.run(endedAt, terminal.offset, id);
    this.activeCommands.clear();
    this.database.prepare("UPDATE terminal_sessions SET ended_at = ? WHERE id = ?")
      .run(endedAt, terminal.id);
    this.activeTerminal = undefined;
  }

  close(endedAt = Date.now()): void {
    if (!this.database.isOpen) return;
    this.endTerminal(endedAt);
    this.database.close();
  }

  private requireTerminal(): ActiveTerminal {
    if (this.activeTerminal === undefined) throw new Error("No active Termia terminal");
    return this.activeTerminal;
  }

  private commandStatement(suffix: string): SqlStatement {
    return this.database.prepare(`
      SELECT
        commands.rowid AS historyIndex,
        commands.id AS id,
        commands.terminal_session_id AS terminalSessionId,
        commands.shell_id AS shellId,
        commands.command AS command,
        commands.cwd AS cwd,
        commands.workspace_uri AS workspaceUri,
        commands.hop_chain AS hopChain,
        commands.started_at AS startedAt,
        commands.ended_at AS endedAt,
        commands.exit_code AS exitCode,
        commands.output_start AS outputStart,
        commands.output_end AS outputEnd,
        terminal_sessions.transcript_path AS transcriptPath
      FROM commands
      JOIN terminal_sessions ON terminal_sessions.id = commands.terminal_session_id
      ${suffix}
    `);
  }
}
