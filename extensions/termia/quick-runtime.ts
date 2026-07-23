import { resolve } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createBashToolDefinition,
  defineTool,
  resolveCliModel,
  resolveModelScopeWithDiagnostics,
  runPrintMode,
  SessionManager,
  SettingsManager,
  type AgentSessionRuntime,
  type AgentSessionRuntimeDiagnostic,
  type CreateAgentSessionRuntimeFactory,
  type CreateAgentSessionFromServicesOptions,
  type CreateAgentSessionServicesOptions,
} from "@earendil-works/pi-coding-agent";
import type { HistoryStore } from "./history.ts";
import { createHistoryTool, termiaSystemPrompt } from "./history-tool.ts";
import { createPtyBashOperations } from "./pty-bash.ts";
import type { QuickAskInvocation } from "./quick-ask.ts";
import type { QuickAskRequest } from "./protocol.ts";
import type { TerminalController } from "./terminal.ts";
import {
  applyWorkspaceToolPolicy,
  presentWorkspaceCwd,
  type WorkspaceBinding,
} from "./workspace.ts";

type ResourceLoaderOptions = NonNullable<CreateAgentSessionServicesOptions["resourceLoaderOptions"]>;

export type QuickRuntimeContext = {
  agentDir: string;
  projectTrusted: boolean;
  termiaExtensionPath: string;
  binding: WorkspaceBinding;
};

export type QuickRuntimeOptions = {
  cwd: string;
  sessionManager: SessionManager;
  settingsManager: SettingsManager;
  resourceLoaderOptions: ResourceLoaderOptions;
  extensionFlagValues: Map<string, boolean | string>;
  thinkingLevel: QuickAskInvocation["piArgs"]["thinking"];
  tools: string[] | undefined;
  excludeTools: string[] | undefined;
  noTools: "all" | "builtin" | undefined;
};

export type QuickPrintResult = {
  exitCode: number;
  output: string;
};

export function excludeTermiaExtension<T extends { resolvedPath: string }>(
  extensions: readonly T[],
  termiaExtensionPath: string,
): T[] {
  const target = resolve(termiaExtensionPath);
  return extensions.filter((extension) => resolve(extension.resolvedPath) !== target);
}

export function quickRuntimeOptions(
  request: QuickAskRequest,
  invocation: QuickAskInvocation,
  context: QuickRuntimeContext,
): QuickRuntimeOptions {
  const args = invocation.piArgs;
  const projectTrusted = args.projectTrustOverride ?? context.projectTrusted;
  const settingsManager = SettingsManager.create(request.cwd, context.agentDir, { projectTrusted });
  const resourceLoaderOptions: ResourceLoaderOptions = {
    noContextFiles: true,
    extensionsOverride: (base) => ({
      ...base,
      extensions: excludeTermiaExtension(base.extensions, context.termiaExtensionPath),
    }),
  };
  if (args.extensions !== undefined) resourceLoaderOptions.additionalExtensionPaths = args.extensions;
  if (args.skills !== undefined) resourceLoaderOptions.additionalSkillPaths = args.skills;
  if (args.promptTemplates !== undefined) {
    resourceLoaderOptions.additionalPromptTemplatePaths = args.promptTemplates;
  }
  if (args.themes !== undefined) resourceLoaderOptions.additionalThemePaths = args.themes;
  if (args.noExtensions !== undefined) resourceLoaderOptions.noExtensions = args.noExtensions;
  if (args.noSkills !== undefined) resourceLoaderOptions.noSkills = args.noSkills;
  if (args.noPromptTemplates !== undefined) {
    resourceLoaderOptions.noPromptTemplates = args.noPromptTemplates;
  }
  if (args.noThemes !== undefined) resourceLoaderOptions.noThemes = args.noThemes;
  if (args.systemPrompt !== undefined) resourceLoaderOptions.systemPrompt = args.systemPrompt;
  if (args.appendSystemPrompt !== undefined) {
    resourceLoaderOptions.appendSystemPrompt = args.appendSystemPrompt;
  }
  resourceLoaderOptions.appendSystemPrompt = [
    ...(resourceLoaderOptions.appendSystemPrompt ?? []),
    termiaSystemPrompt(),
  ];
  return {
    cwd: request.cwd,
    sessionManager: SessionManager.inMemory(request.cwd),
    settingsManager,
    resourceLoaderOptions,
    extensionFlagValues: args.unknownFlags,
    thinkingLevel: args.thinking,
    tools: args.tools,
    excludeTools: args.excludeTools,
    noTools: args.noTools ? "all" : args.noBuiltinTools ? "builtin" : undefined,
  };
}

export function quickBashEnabled(
  options: Pick<QuickRuntimeOptions, "tools" | "excludeTools" | "noTools">,
): boolean {
  if (options.noTools !== undefined) return false;
  if (options.tools !== undefined && !options.tools.includes("bash")) return false;
  return !options.excludeTools?.includes("bash");
}

function runtimeOutput(runtime: AgentSessionRuntime): string {
  const message = runtime.session.state.messages.at(-1);
  if (message?.role !== "assistant") return "";
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    return `${message.errorMessage ?? `Request ${message.stopReason}`}\n`;
  }
  return message.content
    .filter((content) => content.type === "text")
    .map((content) => `${content.text}\n`)
    .join("");
}

async function createQuickRuntime(
  options: QuickRuntimeOptions,
  invocation: QuickAskInvocation,
  history: HistoryStore,
  terminal: TerminalController,
  agentDir: string,
): Promise<AgentSessionRuntime> {
  const args = invocation.piArgs;
  const createRuntime: CreateAgentSessionRuntimeFactory = async ({ sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({
      cwd: options.cwd,
      agentDir,
      settingsManager: options.settingsManager,
      extensionFlagValues: options.extensionFlagValues,
      resourceLoaderOptions: options.resourceLoaderOptions,
    });
    const modelPatterns = args.models ?? services.settingsManager.getEnabledModels();
    const modelScope = modelPatterns === undefined || modelPatterns.length === 0
      ? { scopedModels: [], diagnostics: [] }
      : await resolveModelScopeWithDiagnostics(modelPatterns, services.modelRuntime);
    let modelResult;
    if (args.model !== undefined) {
      const modelOptions: Parameters<typeof resolveCliModel>[0] = {
        cliModel: args.model,
        modelRuntime: services.modelRuntime,
      };
      if (args.provider !== undefined) modelOptions.cliProvider = args.provider;
      if (args.thinking !== undefined) modelOptions.cliThinking = args.thinking;
      modelResult = resolveCliModel(modelOptions);
    }
    const diagnostics: AgentSessionRuntimeDiagnostic[] = [
      ...services.diagnostics,
      ...modelScope.diagnostics,
      ...services.resourceLoader.getExtensions().errors.map(({ path, error }): AgentSessionRuntimeDiagnostic => ({
        type: "error",
        message: `Failed to load extension "${path}": ${error}`,
      })),
    ];
    if (modelResult?.warning !== undefined) {
      diagnostics.push({ type: "warning", message: modelResult.warning });
    }
    if (modelResult?.error !== undefined) {
      diagnostics.push({ type: "error", message: modelResult.error });
    }
    const failures = diagnostics.filter((diagnostic) => diagnostic.type === "error");
    if (failures.length > 0) throw new Error(failures.map((failure) => failure.message).join("\n"));

    const savedProvider = services.settingsManager.getDefaultProvider();
    const savedModel = services.settingsManager.getDefaultModel();
    const savedScopedModel = savedProvider === undefined || savedModel === undefined
      ? undefined
      : modelScope.scopedModels.find((scoped) =>
        scoped.model.provider === savedProvider && scoped.model.id === savedModel,
      );
    const initialScopedModel = savedScopedModel ?? modelScope.scopedModels[0];
    const model = modelResult?.model ?? (args.model === undefined ? initialScopedModel?.model : undefined);
    const thinkingLevel = args.thinking
      ?? modelResult?.thinkingLevel
      ?? (args.model === undefined ? initialScopedModel?.thinkingLevel : undefined);
    const customTools: NonNullable<CreateAgentSessionFromServicesOptions["customTools"]> = [
      createHistoryTool(history),
    ];
    if (quickBashEnabled(options)) {
      customTools.push(defineTool(createBashToolDefinition(options.cwd, {
        operations: createPtyBashOperations(terminal, true),
      })));
    }
    const sessionOptions: CreateAgentSessionFromServicesOptions = {
      services,
      sessionManager,
      customTools,
    };
    if (sessionStartEvent !== undefined) sessionOptions.sessionStartEvent = sessionStartEvent;
    if (model !== undefined) sessionOptions.model = model;
    if (thinkingLevel !== undefined) sessionOptions.thinkingLevel = thinkingLevel;
    if (modelScope.scopedModels.length > 0) sessionOptions.scopedModels = modelScope.scopedModels;
    if (options.tools !== undefined) sessionOptions.tools = options.tools;
    if (options.excludeTools !== undefined) sessionOptions.excludeTools = options.excludeTools;
    if (options.noTools !== undefined) sessionOptions.noTools = options.noTools;
    const created = await createAgentSessionFromServices(sessionOptions);
    return { ...created, services, diagnostics };
  };

  return createAgentSessionRuntime(createRuntime, {
    cwd: options.cwd,
    agentDir,
    sessionManager: options.sessionManager,
  });
}

export async function runQuickPrint(
  request: QuickAskRequest,
  invocation: QuickAskInvocation,
  messages: readonly string[],
  history: HistoryStore,
  terminal: TerminalController,
  context: QuickRuntimeContext,
  signal?: AbortSignal,
): Promise<QuickPrintResult> {
  const first = messages[0];
  if (first === undefined) throw new Error("termia requires a prompt");
  const options = quickRuntimeOptions(request, invocation, context);
  options.resourceLoaderOptions.extensionFactories = [
    ...(options.resourceLoaderOptions.extensionFactories ?? []),
    {
      name: "termia-workspace",
      factory: (pi) => {
        pi.on("before_agent_start", (event) => ({
          systemPrompt: presentWorkspaceCwd(event.systemPrompt, context.binding),
        }));
        pi.on("tool_call", (event) => applyWorkspaceToolPolicy(
          { toolName: event.toolName, input: event.input as Record<string, unknown> },
          context.binding,
          terminal.isWorkspaceHealthy(context.binding),
        ));
      },
    },
  ];
  const previousOffline = process.env.PI_OFFLINE;
  if (invocation.piArgs.offline === true) process.env.PI_OFFLINE = "1";
  let runtime: AgentSessionRuntime | undefined;
  let printOwnsRuntime = false;
  const abort = () => {
    if (runtime !== undefined) void runtime.session.abort();
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    runtime = await createQuickRuntime(
      options,
      invocation,
      history,
      terminal,
      context.agentDir,
    );
    if (signal?.aborted) {
      return { exitCode: 130, output: "Request aborted\n" };
    }
    printOwnsRuntime = true;
    const exitCode = await runPrintMode(runtime, {
      mode: "text",
      initialMessage: first,
      messages: messages.slice(1),
    });
    return {
      exitCode: signal?.aborted ? 130 : exitCode,
      output: runtimeOutput(runtime),
    };
  } finally {
    signal?.removeEventListener("abort", abort);
    if (!printOwnsRuntime) await runtime?.dispose();
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
  }
}
