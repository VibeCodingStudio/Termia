import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { TerminalController } from "./terminal.ts";

export function createPtyBashOperations(
  terminal: TerminalController,
  isolated = false,
): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout }) => {
      const executionAbort = new AbortController();
      let timedOut = false;
      const abort = () => executionAbort.abort();
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
      const timer = timeout === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            executionAbort.abort();
          }, timeout * 1000);

      try {
        if (!terminal.running) terminal.start(cwd);
        terminal.assertWorkspace(cwd);
        const record = await terminal.execute(command, {
          isolated,
          signal: executionAbort.signal,
          onOutput: (data) => onData(Buffer.from(data)),
        });
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${timeout}`);
        return { exitCode: record.exitCode };
      } catch (error) {
        const failure = signal?.aborted
          ? new Error("aborted")
          : timedOut
            ? new Error(`timeout:${timeout}`)
            : error instanceof Error
              ? error
              : new Error(String(error));
        throw failure;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      }
    },
  };
}

export function createModeBashOperations(
  enabled: () => boolean,
  local: BashOperations,
  terminal: TerminalController,
): BashOperations {
  return {
    exec: async (command, cwd, options) => {
      if (!enabled()) return local.exec(command, cwd, options);
      const { onData, signal, timeout } = options;
      const executionAbort = new AbortController();
      let timedOut = false;
      const abort = () => executionAbort.abort();
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
      const timer = timeout === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            executionAbort.abort();
          }, timeout * 1000);
      try {
        if (!terminal.running) terminal.start(cwd);
        terminal.assertWorkspace(cwd);
        const result = await terminal.executeAgent(command, {
          signal: executionAbort.signal,
          onOutput: onData,
        });
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${timeout}`);
        return result;
      } catch (error) {
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${timeout}`);
        throw error;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      }
    },
  };
}
