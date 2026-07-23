import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { spawn, type IPty } from "node-pty";
import { ProtocolParser, type ProtocolToken } from "../extensions/termia/protocol.ts";

const shellDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../extensions/termia/shell");
const zsh = process.env.TERMIA_TEST_ZSH ?? (existsSync("/bin/zsh") ? "/bin/zsh" : undefined);
const ash = process.env.TERMIA_TEST_ASH;

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error(message);
}

class ShellHarness {
  readonly pty: IPty;
  readonly agentRoot: string;
  readonly tokens: ProtocolToken[] = [];
  output = "";
  private readonly parser = new ProtocolParser();

  private constructor(pty: IPty, shellId: string) {
    this.pty = pty;
    this.agentRoot = `/tmp/termia-agent-${shellId}`;
    pty.onData((data) => {
      this.output += data;
      this.tokens.push(...this.parser.push(data));
    });
  }

  static async start(shell: string, hook: "bash" | "zsh" | "ash", cwd: string): Promise<ShellHarness> {
    const args = hook === "bash"
      ? ["--noprofile", "--norc", "-i"]
      : hook === "zsh"
        ? ["-f", "-i"]
        : ["-i"];
    const shellId = `agent-test-${process.pid}-${Date.now()}`;
    const pty = spawn(shell, args, {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd,
      env: {
        ...process.env,
        TERMIA_PTY: "1",
        TERMIA_SHELL_ID: shellId,
        TERMIA_HOOK_DIR: shellDirectory,
      },
    });
    const harness = new ShellHarness(pty, shellId);
    const offset = harness.tokens.length;
    harness.writeLine(`. ${quote(join(shellDirectory, `termia.${hook}`))}`);
    try {
      await harness.waitFor("ready", offset);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${harness.output}`);
    }
    return harness;
  }

  writeLine(line: string): void {
    this.pty.write(`${line}\r`);
  }

  async runParent(command: string): Promise<string> {
    const tokenOffset = this.tokens.length;
    const outputOffset = this.output.length;
    this.writeLine(command);
    await this.waitFor("ready", tokenOffset);
    return this.output.slice(outputOffset);
  }

  async launch(jobId: number, command: string): Promise<Extract<ProtocolToken, { type: "agentJobStart" }>> {
    const tokenOffset = this.tokens.length;
    const encoded = Buffer.from(command).toString("base64");
    this.writeLine(`__termia_agent_stream ${jobId}`);
    await this.waitFor("agentJobTransportReady", tokenOffset, jobId);
    for (let offset = 0; offset < encoded.length; offset += 256) {
      this.writeLine(encoded.slice(offset, offset + 256));
    }
    this.writeLine(".");
    let started: Extract<ProtocolToken, { type: "agentJobStart" }>;
    try {
      started = await this.waitFor("agentJobStart", tokenOffset, jobId);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${this.output}`);
    }
    await this.waitFor("ready", tokenOffset);
    return started;
  }

  async waitForEnd(jobId: number): Promise<Extract<ProtocolToken, { type: "agentJobEnd" }>> {
    const existing = this.find("agentJobEnd", 0, jobId);
    if (existing !== undefined) {
      await this.waitFor("ready", this.tokens.indexOf(existing) + 1);
      return existing;
    }
    for (;;) {
      const tokenOffset = this.tokens.length;
      this.writeLine("__termia_agent_poll");
      const deadline = Date.now() + 250;
      while (Date.now() < deadline) {
        const ended = this.find("agentJobEnd", 0, jobId);
        if (ended !== undefined) {
          await this.waitFor("ready", this.tokens.indexOf(ended) + 1);
          return ended;
        }
        await delay(10);
      }
      await this.waitFor("ready", tokenOffset);
    }
  }

  async waitFor<T extends ProtocolToken["type"]>(
    type: T,
    offset: number,
    jobId?: number,
  ): Promise<Extract<ProtocolToken, { type: T }>> {
    await waitUntil(
      () => this.find(type, offset, jobId) !== undefined,
      `Timed out waiting for ${type}${jobId === undefined ? "" : ` ${jobId}`}`,
    );
    return this.find(type, offset, jobId)!;
  }

  dispose(): void {
    this.pty.kill();
    rmSync(this.agentRoot, { recursive: true, force: true });
  }

  private find<T extends ProtocolToken["type"]>(
    type: T,
    offset: number,
    jobId?: number,
  ): Extract<ProtocolToken, { type: T }> | undefined {
    return this.tokens.slice(offset).find((token) =>
      token.type === type
      && (jobId === undefined || ("jobId" in token && token.jobId === jobId))
    ) as Extract<ProtocolToken, { type: T }> | undefined;
  }
}

async function verifyAgentShell(shell: string, hook: "bash" | "zsh" | "ash"): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "termia-agent-shell-"));
  const cwd = join(root, "cwd");
  mkdirSync(cwd);
  const harness = await ShellHarness.start(shell, hook, cwd);
  try {
    await harness.runParent([
      "TERMIA_PRIVATE=private-value",
      "termia_agent_function() { printf 'function:%s\\n' \"$TERMIA_PRIVATE\"; }",
      "alias termia_agent_alias='printf \"alias-ok\\n\"'",
      "set -a",
      "umask 027",
      `cd ${quote(cwd)}`,
    ].join("; "));
    assert.match(await harness.runParent("alias termia_agent_alias"), /alias-ok/);

    const started = await harness.launch(1, [
      "printf 'variable:%s\\n' \"$TERMIA_PRIVATE\"",
      "termia_agent_function",
      "eval termia_agent_alias",
      "printf 'options:%s\\n' \"$-\"",
      "printf 'umask:%s\\n' \"$(umask)\"",
      "printf 'cwd:%s\\n' \"$PWD\"",
      "TERMIA_PRIVATE=child-value",
      "termia_agent_function() { printf child-function; }",
      "alias termia_agent_alias='printf child-alias'",
      "set +a",
      "cd /",
    ].join("; "));
    assert.equal(started.cwd, cwd);
    const ended = await harness.waitForEnd(1);
    assert.equal(ended.exitCode, 0);
    const transcript = readFileSync(started.transcriptPath, "utf8");
    assert.match(transcript, /variable:private-value/);
    assert.match(transcript, /function:private-value/);
    assert.match(transcript, /alias-ok/);
    assert.match(transcript, /options:.*a/);
    assert.match(transcript, /umask:0?027/);
    assert.match(transcript, new RegExp(`cwd:${cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

    const parent = await harness.runParent("printf 'parent:%s:%s:%s:%s\\n' \"$TERMIA_PRIVATE\" \"$PWD\" \"$-\" \"$(umask)\"");
    assert.match(parent, new RegExp(`parent:private-value:${cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:.*a.*:0?027`));

    const firstReady = join(root, "first.ready");
    const secondReady = join(root, "second.ready");
    const firstGate = join(root, "first.gate");
    const secondGate = join(root, "second.gate");
    const first = await harness.launch(2, `: >${quote(firstReady)}; while [ ! -f ${quote(firstGate)} ]; do sleep 0.02; done; printf first`);
    const second = await harness.launch(3, `: >${quote(secondReady)}; while [ ! -f ${quote(secondGate)} ]; do sleep 0.02; done; printf second`);
    await waitUntil(() => existsSync(firstReady) && existsSync(secondReady), "Agent jobs did not start concurrently");
    writeFileSync(firstGate, "go");
    writeFileSync(secondGate, "go");
    assert.equal((await harness.waitForEnd(2)).exitCode, 0);
    assert.equal((await harness.waitForEnd(3)).exitCode, 0);
    assert.equal(readFileSync(first.transcriptPath, "utf8"), "first");
    assert.equal(readFileSync(second.transcriptPath, "utf8"), "second");
  } finally {
    harness.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}

test("forks Agent jobs from the exact Bash state", async () => {
  await verifyAgentShell("/bin/bash", "bash");
});

test("forks Agent jobs from the exact Zsh state", { skip: zsh === undefined }, async () => {
  await verifyAgentShell(zsh!, "zsh");
});

test("forks Agent jobs from the exact BusyBox ash state", { skip: ash === undefined }, async () => {
  await verifyAgentShell(ash!, "ash");
});
