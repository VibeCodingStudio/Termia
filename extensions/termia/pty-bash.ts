import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { buildRemoteBashCommand } from "./ssh-workspace.ts";
import { TerminalController } from "./terminal.ts";

export function createModeBashOperations(
  enabled: () => boolean,
  local: BashOperations,
  terminal: TerminalController,
): BashOperations {
  return {
    exec: async (command, cwd, options) => {
      if (!enabled()) return local.exec(command, cwd, options);
      terminal.assertWorkspace(cwd);
      const binding = terminal.workspace;
      const resolved = binding.target.scheme === "ssh"
        ? buildRemoteBashCommand(binding.target.hops, binding.target.path, command)
        : command;
      return local.exec(resolved, cwd, options);
    },
  };
}
