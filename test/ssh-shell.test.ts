import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { spawn } from "node-pty";
import { ProtocolParser } from "../extensions/termia/protocol.ts";

const shellDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../extensions/termia/shell");
const zsh = process.env.TERMIA_TEST_ZSH ?? (existsSync("/bin/zsh") ? "/bin/zsh" : undefined);

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function fixture(
  t: TestContext,
  remoteShell = "/bin/bash",
  resolvedShell = remoteShell,
): { bin: string; log: string } {
  const root = mkdtempSync(join(tmpdir(), "termia-ssh-shell-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const log = join(root, "ssh.log");
  mkdirSync(bin);
  const fake = join(bin, "ssh");
  writeFileSync(fake, `#!/bin/sh
{
  printf 'CALL'
  for value do
    printf ' %s' "$(printf '%s' "$value" | base64 | tr -d '\\n')"
  done
  printf '\\n'
} >> "$TERMIA_SSH_TEST_LOG"

if [ "\${1-}" = "-G" ]; then
  printf 'user alice\\nhostname 10.0.0.10\\nport 22\\n'
  exit 0
fi

for value do
  [ "$value" = "-tt" ] && exit 7
done

last=
for value do last=$value; done
case "$last" in
  *'\$SHELL'*) printf '${remoteShell}\\n/home/alice\\n${resolvedShell}\\n' ;;
  *'mktemp -d'*) printf '/tmp/termia-child\\n' ;;
esac
exit 0
`);
  chmodSync(fake, 0o700);
  return { bin, log };
}

function calls(log: string): string[][] {
  return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) =>
    line.split(" ").slice(1).map((value) => Buffer.from(value, "base64").toString()),
  );
}

function runShell(
  command: string,
  env: NodeJS.ProcessEnv,
  shell = "/bin/bash",
  args = ["--noprofile", "--norc", "-c"],
): Promise<{ output: string; exitCode: number }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(shell, [...args, command], {
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      cwd: process.cwd(),
      env,
    });
    let output = "";
    child.onData((data) => {
      output += data;
    });
    child.onExit(({ exitCode }) => resolveRun({ output, exitCode }));
    setTimeout(() => {
      child.kill();
      rejectRun(new Error("Timed out waiting for SSH shell test"));
    }, 5_000).unref();
  });
}

test("passes non-interactive and unsupported SSH forms through unchanged", async (t) => {
  const { bin, log } = fixture(t);
  const script = [
    `source ${quote(join(shellDirectory, "termia-ssh.sh"))}`,
    "ssh host-a uname -a",
    "ssh -L 8080:localhost:80 host-a",
    "ssh -N host-a",
    "ssh -i '/tmp/key with spaces' host-a",
  ].join("\n");
  const result = await runShell(script, {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    TERMIA_PTY: "1",
    TERMIA_SHELL_ID: "local",
    TERMIA_HOOK_DIR: shellDirectory,
    TERMIA_SSH_TEST_LOG: log,
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls(log), [
    ["host-a", "uname", "-a"],
    ["-L", "8080:localhost:80", "host-a"],
    ["-N", "host-a"],
    ["-i", "/tmp/key with spaces", "host-a"],
  ]);
});

test("opens and closes a managed interactive SSH hop", async (t) => {
  const { bin, log } = fixture(t);
  const command = [
    "__termia_b64() { command base64 | command tr -d '\\n'; }",
    `source ${quote(join(shellDirectory, "termia-ssh.sh"))}`,
    "ssh -p 2222 host-a",
    "printf 'STATUS:%s\\n' \"$?\"",
  ].join("\n");
  const result = await runShell(command, {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    TERMIA_PTY: "1",
    TERMIA_SHELL_ID: "local",
    TERMIA_HOOK_DIR: shellDirectory,
    TERMIA_SSH_TEST_LOG: log,
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /STATUS:7/);

  const events = new ProtocolParser().push(result.output).filter((token) => token.type !== "output");
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], {
    type: "sshOpen",
    parentShellId: "local",
    shellId: "local.1",
    destination: "host-a",
    user: "alice",
    host: "10.0.0.10",
    port: 22,
    controlPath: events[0]?.type === "sshOpen" ? events[0].controlPath : "",
    cwd: "/home/alice",
  });
  assert.match(events[0]?.type === "sshOpen" ? events[0].controlPath : "", /^\/tmp\/termia-ssh\./);
  assert.deepEqual(events[1], { type: "sshClose", shellId: "local.1" });

  const invocations = calls(log);
  assert.deepEqual(invocations[0], ["-G", "-p", "2222", "host-a"]);
  assert.equal(invocations.some((argv) => argv.includes("-M") && argv.includes("-fN")), true);
  assert.equal(invocations.some((argv) => argv.includes("-tt")), true);
  assert.equal(invocations.some((argv) => argv.includes("-O") && argv.includes("exit")), true);
  assert.equal(invocations.flat().some((value) => /IdentityFile|private.key|reconnect/.test(value)), false);
});

test("preserves managed SSH status in zsh", { skip: zsh === undefined }, async (t) => {
  const { bin, log } = fixture(t);
  const command = [
    "__termia_b64() { command base64 | command tr -d '\\n'; }",
    `source ${quote(join(shellDirectory, "termia-ssh.sh"))}`,
    "ssh host-a",
    "printf 'STATUS:%s\\n' \"$?\"",
  ].join("\n");
  const result = await runShell(command, {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    TERMIA_PTY: "1",
    TERMIA_SHELL_ID: "local",
    TERMIA_HOOK_DIR: shellDirectory,
    TERMIA_SSH_TEST_LOG: log,
  }, zsh!, ["-f", "-c"]);

  assert.equal(result.exitCode, 0);
  assert.match(result.output, /STATUS:7/);
  assert.doesNotMatch(result.output, /read-only variable: status/);
});

for (const [name, shell, resolved] of [
  ["ash", "/bin/ash", "/bin/busybox"],
  ["BusyBox sh", "/bin/sh", "/bin/busybox"],
] as const) {
  test(`opens a managed interactive SSH hop for ${name}`, async (t) => {
    const { bin, log } = fixture(t, shell, resolved);
    const command = [
      "__termia_b64() { command base64 | command tr -d '\\n'; }",
      `source ${quote(join(shellDirectory, "termia-ssh.sh"))}`,
      "ssh host-a",
    ].join("\n");
    const result = await runShell(command, {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      TERMIA_PTY: "1",
      TERMIA_SHELL_ID: "local",
      TERMIA_HOOK_DIR: shellDirectory,
      TERMIA_SSH_TEST_LOG: log,
    });

    const events = new ProtocolParser().push(result.output).filter((token) => token.type !== "output");
    assert.equal(events[0]?.type, "sshOpen");
    assert.equal(events[1]?.type, "sshClose");
    const invocations = calls(log);
    assert.equal(invocations.some((argv) => argv.includes("-tt")), true);
    const launch = invocations.find((argv) => argv.includes("-tt"))?.at(-1) ?? "";
    assert.match(launch, /TERMIA_ASH_LOGIN=1/);
    assert.match(launch, /ENV='\/tmp\/termia-child\/termia\.ash'/);
    assert.match(launch, /exec '\/bin\/(?:ash|sh)' -i$/);
    assert.doesNotMatch(launch, /-il/);
  });
}

test("uses ucode when ash has no base64 command", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "termia-ash-codec-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  mkdirSync(bin);
  symlinkSync("/usr/bin/sed", join(bin, "sed"));
  writeFileSync(join(bin, "ucode"), `#!/bin/sh
case "$*" in
  *b64enc*) /usr/bin/base64 -w0 ;;
  *b64dec*) /usr/bin/base64 -d ;;
esac
`, { mode: 0o700 });
  const command = [
    `. ${quote(join(shellDirectory, "termia.ash"))}`,
    "encoded=$(printf abc | __termia_b64)",
    "decoded=$(printf YWJj | __termia_unb64)",
    "printf '%s:%s\\n' \"$encoded\" \"$decoded\"",
  ].join("\n");
  const result = await runShell(command, {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    TERMIA_PTY: "1",
    TERMIA_SHELL_ID: "local",
    TERMIA_HOOK_DIR: shellDirectory,
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.output, /YWJj:abc/);
});
