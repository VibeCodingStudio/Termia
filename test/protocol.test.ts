import assert from "node:assert/strict";
import test from "node:test";
import { ProtocolParser } from "../extensions/termia/protocol.ts";

const b64 = (value: string) => Buffer.from(value).toString("base64");
const frame = (payload: string) => `\u001b]6973;${payload}\u0007`;

test("parses output and a command start in order", () => {
  const parser = new ProtocolParser();
  assert.deepEqual(parser.push(`prompt${frame(`S;${b64("local")};7;${b64("/tmp/a")};${b64("echo hi")}`)}out`), [
    { type: "output", data: "prompt" },
    { type: "start", shellId: "local", sequence: 7, cwd: "/tmp/a", command: "echo hi" },
    { type: "output", data: "out" },
  ]);
});

test("round-trips a quick ask with exact shell arguments", () => {
  const parser = new ProtocolParser();
  const argv = ["spaces here", "quotes: '\"", "你好", ""];
  const encodedArgv = Buffer.from(`${argv.join("\u0000")}\u0000`).toString("base64");
  assert.deepEqual(parser.push(frame(`Q;${b64("local")};${b64("/tmp/工作")};${argv.length};${encodedArgv}`)), [
    { type: "quickAsk", shellId: "local", cwd: "/tmp/工作", argv },
  ]);
  assert.deepEqual(parser.push(frame(`Q;${b64("local")};${b64("/tmp")};0;`)), [
    { type: "quickAsk", shellId: "local", cwd: "/tmp", argv: [] },
  ]);
});

test("keeps malformed quick asks as terminal output", () => {
  const parser = new ProtocolParser();
  const malformed = [
    frame(`Q;${b64("local")};${b64("/tmp")};2;${b64("one\u0000")}`),
    frame(`Q;${b64("local")};${b64("/tmp")};nope;${b64("one\u0000")}`),
    frame(`Q;${b64("local")};${b64("/tmp")};1;%%%bad%%%`),
    frame(`Q;${b64("local")};${b64("/tmp")};1;${b64("one\u0000")};extra`),
    frame(`Q;;${b64("/tmp")};1;${b64("one\u0000")}`),
  ];
  for (const value of malformed) {
    assert.deepEqual(parser.push(value), [{ type: "output", data: value }]);
  }
});

test("buffers a split frame", () => {
  const parser = new ProtocolParser();
  assert.deepEqual(parser.push(`x\u001b]6973;E;${b64("local")};7;`), [{ type: "output", data: "x" }]);
  assert.deepEqual(parser.push(`0;${b64("/tmp/b")}\u0007y`), [
    { type: "end", shellId: "local", sequence: 7, cwd: "/tmp/b", exitCode: 0 },
    { type: "output", data: "y" },
  ]);
});

test("buffers a marker prefix split across chunks", () => {
  const parser = new ProtocolParser();
  assert.deepEqual(parser.push("x\u001b]69"), [{ type: "output", data: "x" }]);
  assert.deepEqual(parser.push(`73;R;${b64("local")};${b64("/tmp/c")}\u0007`), [
    { type: "ready", shellId: "local", cwd: "/tmp/c" },
  ]);
});

test("parses an explicit-execution shell capability", () => {
  const parser = new ProtocolParser();
  assert.deepEqual(parser.push(frame(`R;${b64("ash")};${b64("/root")};X`)), [
    { type: "ready", shellId: "ash", cwd: "/root", explicitExec: true },
  ]);
});

test("parses a command observed after ash returns to its prompt", () => {
  const parser = new ProtocolParser();
  assert.deepEqual(
    parser.push(frame(`C;${b64("ash")};42;7;${b64("/root/sub")};${b64("cd sub; false")}`)),
    [{
      type: "observed",
      shellId: "ash",
      historyId: 42,
      cwd: "/root/sub",
      command: "cd sub; false",
      exitCode: 7,
    }],
  );
});

test("keeps malformed frames as terminal output", () => {
  const parser = new ProtocolParser();
  const malformed = frame(`S;${b64("local")};bad;%%%bad%%%;%%%bad%%%`);
  assert.deepEqual(parser.push(malformed), [{ type: "output", data: malformed }]);
});

test("flushes an unterminated frame as output", () => {
  const parser = new ProtocolParser();
  assert.deepEqual(parser.push("before\u001b]6973;R;c2hlbGw=;pending"), [{ type: "output", data: "before" }]);
  assert.deepEqual(parser.flush(), [{ type: "output", data: "\u001b]6973;R;c2hlbGw=;pending" }]);
  assert.deepEqual(parser.flush(), []);
});

test("parses namespaced ready, command, and quick-ask frames", () => {
  const parser = new ProtocolParser();
  const argv = Buffer.from("why\u0000--attach\u0000").toString("base64");
  const input = [
    frame(`R;${b64("shell-b")};${b64("/srv/app")}`),
    frame(`S;${b64("shell-b")};7;${b64("/srv/app")};${b64("pwd")}`),
    frame(`E;${b64("shell-b")};7;0;${b64("/srv/app")}`),
    frame(`Q;${b64("shell-b")};${b64("/srv/app")};2;${argv}`),
  ].join("");
  assert.deepEqual(parser.push(input), [
    { type: "ready", shellId: "shell-b", cwd: "/srv/app" },
    { type: "start", shellId: "shell-b", sequence: 7, cwd: "/srv/app", command: "pwd" },
    { type: "end", shellId: "shell-b", sequence: 7, cwd: "/srv/app", exitCode: 0 },
    { type: "quickAsk", shellId: "shell-b", cwd: "/srv/app", argv: ["why", "--attach"] },
  ]);
});

test("parses SSH hop open and close frames", () => {
  const parser = new ProtocolParser();
  const open = frame([
    "H",
    b64("local"),
    b64("shell-a"),
    b64("host-a"),
    b64("alice"),
    b64("10.0.0.10"),
    "22",
    b64("/tmp/termia/control"),
    b64("/home/alice"),
  ].join(";"));
  const close = frame(`L;${b64("shell-a")}`);
  assert.deepEqual(parser.push(open + close), [
    {
      type: "sshOpen",
      parentShellId: "local",
      shellId: "shell-a",
      destination: "host-a",
      user: "alice",
      host: "10.0.0.10",
      port: 22,
      controlPath: "/tmp/termia/control",
      cwd: "/home/alice",
    },
    { type: "sshClose", shellId: "shell-a" },
  ]);
});

test("parses the Agent job lifecycle", () => {
  const parser = new ProtocolParser();
  const input = [
    frame(`A;R;${b64("shell-a")};7`),
    frame(`A;S;${b64("shell-a")};7;4123;${b64("/srv/app")};${b64("/tmp/termia-agent-shell-a/7/output")}`),
    frame(`A;W;${b64("shell-a")};7`),
    frame(`A;F;${b64("shell-a")};7`),
    frame(`A;B;${b64("shell-a")};7`),
    frame(`A;E;${b64("shell-a")};7;23;${b64("/srv/app/sub")}`),
  ].join("");

  assert.deepEqual(parser.push(input), [
    { type: "agentJobTransportReady", shellId: "shell-a", jobId: 7 },
    {
      type: "agentJobStart",
      shellId: "shell-a",
      jobId: 7,
      processGroupId: 4123,
      cwd: "/srv/app",
      transcriptPath: "/tmp/termia-agent-shell-a/7/output",
    },
    { type: "agentJobWaiting", shellId: "shell-a", jobId: 7 },
    { type: "agentJobForeground", shellId: "shell-a", jobId: 7 },
    { type: "agentJobBackground", shellId: "shell-a", jobId: 7 },
    { type: "agentJobEnd", shellId: "shell-a", jobId: 7, exitCode: 23, cwd: "/srv/app/sub" },
  ]);
});

test("keeps malformed Agent job frames as output", () => {
  const parser = new ProtocolParser();
  for (const value of [
    frame(`A;S;${b64("shell-a")};-1;4;${b64("/tmp")};${b64("/tmp/out")}`),
    frame(`A;S;${b64("shell-a")};1;0;${b64("/tmp")};${b64("relative")}`),
    frame(`A;E;${b64("shell-a")};1;999;${b64("/tmp")}`),
    frame(`A;W;${b64("shell-a")};nope`),
  ]) {
    assert.deepEqual(parser.push(value), [{ type: "output", data: value }]);
  }
});

test("keeps invalid SSH hop metadata as terminal output", () => {
  const parser = new ProtocolParser();
  const invalid = [
    frame(`H;${b64("local")};${b64("shell-a")};${b64("host-a")};${b64("alice")};${b64("host-a")};0;${b64("/tmp/control")};${b64("/home/alice")}`),
    frame(`H;${b64("local")};${b64("shell-a")};${b64("host-a")};${b64("alice")};${b64("host-a")};22;${b64("relative")};${b64("/home/alice")}`),
    frame("L;"),
  ];
  for (const value of invalid) {
    assert.deepEqual(parser.push(value), [{ type: "output", data: value }]);
  }
});
