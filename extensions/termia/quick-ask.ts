import { parseArgs, type Args } from "@earendil-works/pi-coding-agent";
import { formatHistoryContext } from "./history-overlay.ts";
import type { CommandRecord, HistoryStore } from "./history.ts";

const MAX_HISTORY_COMMANDS = 1000;

export type QuickHistorySelection =
  | { kind: "none" }
  | { kind: "last"; count: number }
  | { kind: "all" };

export type QuickAskInvocation = {
  attach: boolean;
  history: QuickHistorySelection;
  piArgs: Args;
};

function historyCount(value: string | undefined, option: string): number {
  if (value === undefined) throw new Error(`${option} requires a positive integer`);
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error(`${option} requires a positive integer`);
  }
  if (count > MAX_HISTORY_COMMANDS) {
    throw new Error(`${option} cannot exceed ${MAX_HISTORY_COMMANDS}`);
  }
  return count;
}

function consumeTermiaArguments(argv: readonly string[]): {
  attach: boolean;
  history: QuickHistorySelection;
  piArgv: string[];
} {
  let attach = false;
  let history: QuickHistorySelection = { kind: "none" };
  let hasHistorySelector = false;
  const piArgv: string[] = [];

  const selectHistory = (selection: QuickHistorySelection): void => {
    if (hasHistorySelector) throw new Error("Use only one history selector");
    history = selection;
    hasHistorySelector = true;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (argument === "--attach") {
      if (attach) throw new Error("Use --attach only once");
      attach = true;
      continue;
    }
    if (argument === "-n" || argument === "--last") {
      selectHistory({ kind: "last", count: historyCount(argv[index + 1], argument) });
      index += 1;
      continue;
    }
    if (argument === "--all") {
      selectHistory({ kind: "all" });
      continue;
    }
    const compactHistory = /^h~(\d+)$/.exec(argument);
    if (compactHistory !== null) {
      selectHistory({ kind: "last", count: historyCount(compactHistory[1], "h~N") });
      continue;
    }
    piArgv.push(argument);
  }

  return { attach, history, piArgv };
}

function rejectSessionArguments(args: Args): void {
  if (
    args.continue === true
    || args.resume === true
    || args.session !== undefined
    || args.sessionId !== undefined
    || args.fork !== undefined
    || args.sessionDir !== undefined
    || args.name !== undefined
  ) {
    throw new Error("Pi session selection and mutation arguments are not supported by termia");
  }
  if (args.apiKey !== undefined) throw new Error("--api-key is not supported by termia");
  if (
    args.help === true
    || args.version === true
    || args.mode !== undefined
    || args.export !== undefined
    || args.listModels !== undefined
  ) {
    throw new Error("Pi lifecycle and output-mode arguments are not supported by termia");
  }
}

function rejectAttachOverrides(args: Args): void {
  const hasOverride = args.provider !== undefined
    || args.model !== undefined
    || args.systemPrompt !== undefined
    || args.appendSystemPrompt !== undefined
    || args.thinking !== undefined
    || args.models !== undefined
    || args.tools !== undefined
    || args.excludeTools !== undefined
    || args.noTools === true
    || args.noBuiltinTools === true
    || args.extensions !== undefined
    || args.noExtensions === true
    || args.skills !== undefined
    || args.noSkills === true
    || args.promptTemplates !== undefined
    || args.noPromptTemplates === true
    || args.themes !== undefined
    || args.noThemes === true
    || args.noContextFiles === true
    || args.offline === true
    || args.verbose === true
    || args.projectTrustOverride !== undefined
    || args.unknownFlags.size > 0;
  if (hasOverride) {
    throw new Error("--attach uses the active Pi session and cannot override its model, tools, or resources");
  }
}

export function parseQuickAskArguments(argv: readonly string[]): QuickAskInvocation {
  const termiaArgs = consumeTermiaArguments(argv);
  const piArgs = parseArgs(termiaArgs.piArgv);
  const diagnostics = piArgs.diagnostics.map((diagnostic) => diagnostic.message);
  if (diagnostics.length > 0) throw new Error(diagnostics.join("\n"));
  rejectSessionArguments(piArgs);
  if (piArgs.fileArgs.length > 0) {
    throw new Error("@file arguments are not supported by termia quick ask");
  }
  if (piArgs.messages.length === 0) throw new Error("termia requires a prompt");
  if (termiaArgs.attach) rejectAttachOverrides(piArgs);
  return { attach: termiaArgs.attach, history: termiaArgs.history, piArgs };
}

export function selectQuickHistory(
  store: HistoryStore,
  selection: QuickHistorySelection,
): CommandRecord[] {
  if (selection.kind === "none") return [];
  const limit = selection.kind === "all" ? MAX_HISTORY_COMMANDS : selection.count;
  return store.listCompletedCommands(limit).reverse();
}

export function buildQuickMessages(
  messages: readonly string[],
  commands: CommandRecord[],
): string[] {
  const first = messages[0];
  if (first === undefined) throw new Error("termia requires a prompt");
  if (commands.length === 0) return [...messages];
  return [`${formatHistoryContext(commands)}\n\n${first}`, ...messages.slice(1)];
}
