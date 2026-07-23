import { stripVTControlCharacters } from "node:util";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { HistoryStore } from "./history.ts";

const parameters = Type.Object({
  index: Type.Integer({ minimum: 1, description: "Stable Termia history index" }),
  offset: Type.Optional(Type.Integer({ minimum: 1, description: "Output line to start from (1-indexed)" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of output lines" })),
});

type HistoryToolInput = {
  index: number;
  offset?: number;
  limit?: number;
};

type HistoryToolDetails = {
  totalLines: number;
  hasMore: boolean;
};

type HistoryToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: HistoryToolDetails;
};

export const TERMIA_PROMPT_GUIDELINES = [
  "While Termia mode is active, reason from observed system state rather than following a memorized runbook.",
  "In Termia, treat the active workspace, host, user, shell, working directory, and Termia history as operational state.",
  "In Termia, inspect before changing anything: verify the target host, user, working directory, shell, privilege level, operating system, service manager, container runtime, installed tools, and deployment model instead of assuming them.",
  "In Termia, start with the smallest relevant read-only checks, form a hypothesis, test it narrowly, and distinguish symptoms from root causes.",
  "In Termia, prefer existing system facilities and project conventions over introducing new tools or infrastructure.",
  "In Termia, keep investigations scoped to the reported problem and preserve unrelated processes, configuration, files, and user changes.",
  "In Termia, never expose credentials, tokens, private keys, passwords, or other secrets in commands, logs, history, or responses.",
  "In Termia, re-read state after every change and verify the intended outcome instead of assuming success.",
  "Termia troubleshooting order is: confirm host, user, working directory, shell, and privileges; check service or process status; inspect recent relevant logs and exact errors; check CPU, memory, load, disk, inodes, and OOM events; check network state including listening ports, routing, DNS, TLS, firewall rules, and reachability; check databases, APIs, mounts, queues, and other dependencies; then reproduce narrowly, make the smallest justified change, and verify recovery.",
  "In Termia, do not restart an unhealthy service until evidence explains why a restart is appropriate and whether it could hide the underlying failure.",
  "In a local Termia workspace, commands and file operations target the local host and active local working directory.",
  "In a local Termia workspace, the interactive PTY persists across Agent and terminal views, and Agent file tools and bash operations target the same active workspace.",
  "In Termia, do not assume that environment or directory changes inside an isolated Agent bash call mutate the interactive PTY.",
  "In Termia, use Termia history when previous commands or output are relevant to the investigation.",
  "In an SSH Termia workspace, commands and file operations target the active remote workspace rather than the local machine; relative paths use the remote working directory and absolute paths use the remote root.",
  "In an SSH Termia workspace, use logical remote paths and never inspect or expose Termia's local mount implementation.",
  "In nested SSH, treat the current leaf host as the active target while retaining the identity of parent hops.",
  "Before changing an SSH Termia workspace, verify the remote host, user, working directory, and privilege level to avoid acting on the wrong machine.",
  "In an SSH Termia workspace, never reconnect automatically, reuse credentials, or assume key-based authentication; stop safely and let the user reconnect manually.",
  "In an SSH Termia workspace, account for latency, disconnects, incomplete output, and commands that may still be running before retrying an operation.",
  "In an SSH Termia workspace, keep command-history conclusions scoped to the host and workspace recorded with each command.",
  "In Termia, treat service stop, restart, or reload; host reboot or shutdown; SSH, firewall, routing, or DNS changes; user, permission, sudo, authentication, or secret changes; system package installation, upgrade, or removal; disk, filesystem, mount, database, backup, or persistent-data changes; recursive deletion; and bulk overwrite as high-risk operations.",
  "In Termia, execute a high-risk operation without another confirmation only when the user has explicitly authorized the exact target and action; otherwise confirm before proceeding.",
  "Before a high-risk Termia operation, resolve the exact host, target, and blast radius; perform relevant read-only checks; preserve current access; prefer reversible or staged changes; and identify rollback or recovery options.",
  "For high-risk Termia operations, avoid broad paths, unresolved variables, unsafe globs, and ambiguous targets.",
  "After a high-risk Termia operation, verify service, access, resource, and dependency state, then report what changed and any remaining risk.",
] as const;

export function termiaSystemPrompt(): string {
  return `# Termia Operational Behavior\n\n${TERMIA_PROMPT_GUIDELINES.map((guideline) => `- ${guideline}`).join("\n")}`;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function cleanOutput(output: string): string {
  return stripVTControlCharacters(output).replace(/\r\n?/g, "\n");
}

function outputLines(output: string): string[] {
  if (output.length === 0) return [];
  const lines = output.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function continuation(remaining: number, offset: number): string {
  const unit = remaining === 1 ? "line" : "lines";
  return `[${remaining} more ${unit}. Use offset=${offset} to continue.]`;
}

export function readHistoryPage(
  store: HistoryStore,
  input: HistoryToolInput,
): HistoryToolResult {
  const index = positiveInteger(input.index, "History index");
  const offset = positiveInteger(input.offset ?? 1, "History offset");
  const limit = input.limit === undefined
    ? undefined
    : positiveInteger(input.limit, "History limit");
  const command = store.getCommand(index);
  if (command === undefined) throw new Error(`Termia history #${index} was not found`);

  const output = cleanOutput(store.readOutput(command));
  if (output.length === 0) {
    return {
      content: [{ type: "text", text: "(no output)" }],
      details: { totalLines: 0, hasMore: false },
    };
  }

  const lines = outputLines(output);
  const start = offset - 1;
  if (start >= lines.length) {
    throw new Error(`Offset ${offset} is beyond command output (${lines.length} lines total)`);
  }

  const end = limit === undefined
    ? lines.length
    : Math.min(start + limit, lines.length);
  const truncated = truncateHead(lines.slice(start, end).join("\n"));
  let text = truncated.firstLineExceedsLimit
    ? `[Line ${offset} exceeds the ${DEFAULT_MAX_BYTES / 1024}KB output limit.]`
    : truncated.content;
  if (!truncated.truncated && end === lines.length && output.endsWith("\n")) {
    text += "\n";
  }
  const shown = truncated.firstLineExceedsLimit
    ? 1
    : truncated.truncated
      ? truncated.outputLines
      : end - start;
  const remaining = lines.length - (start + shown);
  const hasMore = remaining > 0;
  if (hasMore) {
    const nextOffset = offset + shown;
    text += `\n\n${continuation(remaining, nextOffset)}`;
  }
  return {
    content: [{ type: "text", text }],
    details: { totalLines: lines.length, hasMore },
  };
}

export function createHistoryTool(store: HistoryStore) {
  return defineTool({
    name: "termia_history",
    label: "Termia history",
    description: `Read command output by the Termia history index included in user context. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB. Use offset/limit to continue.`,
    promptSnippet: "Read selected Termia command output by history index",
    promptGuidelines: [...TERMIA_PROMPT_GUIDELINES],
    parameters,
    async execute(_toolCallId, input, signal) {
      signal?.throwIfAborted();
      return readHistoryPage(store, input);
    },
  });
}
