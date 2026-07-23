export type OutputToken = { type: "output"; data: string };
export type ReadyEvent = {
  type: "ready";
  shellId: string;
  cwd: string;
  explicitExec?: true;
};
export type CommandStartEvent = {
  type: "start";
  shellId: string;
  sequence: number;
  cwd: string;
  command: string;
};
export type CommandEndEvent = {
  type: "end";
  shellId: string;
  sequence: number;
  cwd: string;
  exitCode: number;
};
export type CommandObservedEvent = {
  type: "observed";
  shellId: string;
  historyId: number;
  cwd: string;
  command: string;
  exitCode: number;
};
export type QuickAskRequest = { shellId: string; cwd: string; argv: string[] };
export type QuickAskEvent = QuickAskRequest & { type: "quickAsk" };
export type SshOpenEvent = {
  type: "sshOpen";
  parentShellId: string;
  shellId: string;
  destination: string;
  user: string;
  host: string;
  port: number;
  controlPath: string;
  cwd: string;
};
export type SshCloseEvent = { type: "sshClose"; shellId: string };
export type AgentJobStartEvent = {
  type: "agentJobStart";
  shellId: string;
  jobId: number;
  processGroupId: number;
  cwd: string;
  transcriptPath: string;
};
export type AgentJobWaitingEvent = {
  type: "agentJobWaiting";
  shellId: string;
  jobId: number;
};
export type AgentJobForegroundEvent = {
  type: "agentJobForeground";
  shellId: string;
  jobId: number;
};
export type AgentJobBackgroundEvent = {
  type: "agentJobBackground";
  shellId: string;
  jobId: number;
};
export type AgentJobEndEvent = {
  type: "agentJobEnd";
  shellId: string;
  jobId: number;
  exitCode: number;
  cwd: string;
};
export type ProtocolToken =
  | OutputToken
  | ReadyEvent
  | CommandStartEvent
  | CommandEndEvent
  | CommandObservedEvent
  | QuickAskEvent
  | SshOpenEvent
  | SshCloseEvent
  | AgentJobStartEvent
  | AgentJobWaitingEvent
  | AgentJobForegroundEvent
  | AgentJobBackgroundEvent
  | AgentJobEndEvent;

const PREFIX = "\u001b]6973;";
const END = "\u0007";

function decode(value: string): string | undefined {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return undefined;
  }
  return Buffer.from(value, "base64").toString("utf8");
}

function decodeArguments(value: string, count: number): string[] | undefined {
  if (!Number.isSafeInteger(count) || count < 0 || count > 4096) return undefined;
  const decoded = decode(value);
  if (decoded === undefined) return undefined;
  if (count === 0) return decoded.length === 0 ? [] : undefined;
  if (!decoded.endsWith("\u0000")) return undefined;
  const argv = decoded.slice(0, -1).split("\u0000");
  return argv.length === count ? argv : undefined;
}

function decodedText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const result = decode(value);
  return result === undefined || result.length === 0 || result.includes("\0") ? undefined : result;
}

function decodedAbsolutePath(value: string | undefined): string | undefined {
  const result = decodedText(value);
  return result?.startsWith("/") ? result : undefined;
}

function parsePayload(payload: string): Exclude<ProtocolToken, OutputToken> | undefined {
  const fields = payload.split(";");
  const kind = fields[0];
  if (kind === "R" && (fields.length === 3 || (fields.length === 4 && fields[3] === "X"))) {
    const shellId = decodedText(fields[1]);
    const cwd = decodedAbsolutePath(fields[2]);
    if (shellId === undefined || cwd === undefined) return undefined;
    return fields.length === 4
      ? { type: "ready", shellId, cwd, explicitExec: true }
      : { type: "ready", shellId, cwd };
  }
  if (kind === "S" && fields.length === 5) {
    const shellId = decodedText(fields[1]);
    const sequence = Number(fields[2]);
    const cwd = decodedAbsolutePath(fields[3]);
    const command = decode(fields[4] ?? "");
    if (
      shellId === undefined
      || !Number.isSafeInteger(sequence)
      || sequence < 0
      || cwd === undefined
      || command === undefined
    ) return undefined;
    return { type: "start", shellId, sequence, cwd, command };
  }
  if (kind === "E" && fields.length === 5) {
    const shellId = decodedText(fields[1]);
    const sequence = Number(fields[2]);
    const exitCode = Number(fields[3]);
    const cwd = decodedAbsolutePath(fields[4]);
    if (
      shellId === undefined
      || !Number.isSafeInteger(sequence)
      || sequence < 0
      || !Number.isInteger(exitCode)
      || exitCode < 0
      || exitCode > 255
      || cwd === undefined
    ) return undefined;
    return { type: "end", shellId, sequence, cwd, exitCode };
  }
  if (kind === "C" && fields.length === 6) {
    const shellId = decodedText(fields[1]);
    const historyId = Number(fields[2]);
    const exitCode = Number(fields[3]);
    const cwd = decodedAbsolutePath(fields[4]);
    const command = decodedText(fields[5]);
    if (
      shellId === undefined
      || !Number.isSafeInteger(historyId)
      || historyId < 0
      || !Number.isInteger(exitCode)
      || exitCode < 0
      || exitCode > 255
      || cwd === undefined
      || command === undefined
    ) return undefined;
    return { type: "observed", shellId, historyId, cwd, command, exitCode };
  }
  if (kind === "Q" && fields.length === 5) {
    const shellId = decodedText(fields[1]);
    const cwd = decodedAbsolutePath(fields[2]);
    const argv = decodeArguments(fields[4] ?? "", Number(fields[3]));
    if (shellId === undefined || cwd === undefined || argv === undefined) return undefined;
    return { type: "quickAsk", shellId, cwd, argv };
  }
  if (kind === "H" && fields.length === 9) {
    const parentShellId = decodedText(fields[1]);
    const shellId = decodedText(fields[2]);
    const destination = decodedText(fields[3]);
    const user = decodedText(fields[4]);
    const host = decodedText(fields[5]);
    const port = Number(fields[6]);
    const controlPath = decodedAbsolutePath(fields[7]);
    const cwd = decodedAbsolutePath(fields[8]);
    if (
      parentShellId === undefined
      || shellId === undefined
      || destination === undefined
      || user === undefined
      || host === undefined
      || !Number.isInteger(port)
      || port < 1
      || port > 65535
      || controlPath === undefined
      || cwd === undefined
    ) return undefined;
    return {
      type: "sshOpen",
      parentShellId,
      shellId,
      destination,
      user,
      host,
      port,
      controlPath,
      cwd,
    };
  }
  if (kind === "L" && fields.length === 2) {
    const shellId = decodedText(fields[1]);
    return shellId === undefined ? undefined : { type: "sshClose", shellId };
  }
  if (kind === "A") {
    const action = fields[1];
    const shellId = decodedText(fields[2]);
    const jobId = Number(fields[3]);
    if (
      shellId === undefined
      || !Number.isSafeInteger(jobId)
      || jobId < 0
    ) return undefined;
    if (action === "S" && fields.length === 7) {
      const processGroupId = Number(fields[4]);
      const cwd = decodedAbsolutePath(fields[5]);
      const transcriptPath = decodedAbsolutePath(fields[6]);
      if (
        !Number.isSafeInteger(processGroupId)
        || processGroupId <= 0
        || cwd === undefined
        || transcriptPath === undefined
      ) return undefined;
      return {
        type: "agentJobStart",
        shellId,
        jobId,
        processGroupId,
        cwd,
        transcriptPath,
      };
    }
    if (fields.length === 4) {
      if (action === "W") return { type: "agentJobWaiting", shellId, jobId };
      if (action === "F") return { type: "agentJobForeground", shellId, jobId };
      if (action === "B") return { type: "agentJobBackground", shellId, jobId };
    }
    if (action === "E" && fields.length === 6) {
      const exitCode = Number(fields[4]);
      const cwd = decodedAbsolutePath(fields[5]);
      if (
        !Number.isInteger(exitCode)
        || exitCode < 0
        || exitCode > 255
        || cwd === undefined
      ) return undefined;
      return { type: "agentJobEnd", shellId, jobId, exitCode, cwd };
    }
  }
  return undefined;
}

function partialPrefixLength(value: string): number {
  for (let length = Math.min(value.length, PREFIX.length - 1); length > 0; length -= 1) {
    if (value.endsWith(PREFIX.slice(0, length))) return length;
  }
  return 0;
}

export class ProtocolParser {
  private pending = "";

  push(chunk: string): ProtocolToken[] {
    this.pending += chunk;
    const tokens: ProtocolToken[] = [];

    while (this.pending.length > 0) {
      const start = this.pending.indexOf(PREFIX);
      if (start < 0) {
        const retained = partialPrefixLength(this.pending);
        const output = this.pending.slice(0, this.pending.length - retained);
        if (output.length > 0) tokens.push({ type: "output", data: output });
        this.pending = this.pending.slice(this.pending.length - retained);
        break;
      }
      if (start > 0) {
        tokens.push({ type: "output", data: this.pending.slice(0, start) });
        this.pending = this.pending.slice(start);
      }

      const end = this.pending.indexOf(END, PREFIX.length);
      if (end < 0) break;

      const raw = this.pending.slice(0, end + END.length);
      const event = parsePayload(this.pending.slice(PREFIX.length, end));
      tokens.push(event ?? { type: "output", data: raw });
      this.pending = this.pending.slice(end + END.length);
    }

    return tokens;
  }

  flush(): ProtocolToken[] {
    if (this.pending.length === 0) return [];
    const output: OutputToken = { type: "output", data: this.pending };
    this.pending = "";
    return [output];
  }
}
