import { resolve } from "node:path";

const HISTORY_TOOL = "termia_history";

export function termiaRoot(agentDir: string): string {
  return resolve(agentDir, "termia");
}

export function withTermiaHistoryTool(
  activeTools: readonly string[],
  enabled: boolean,
): string[] {
  if (!enabled) return activeTools.filter((tool) => tool !== HISTORY_TOOL);

  let included = false;
  const tools = activeTools.filter((tool) => {
    if (tool !== HISTORY_TOOL) return true;
    if (included) return false;
    included = true;
    return true;
  });
  if (!included) tools.push(HISTORY_TOOL);
  return tools;
}
