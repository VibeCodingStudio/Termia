import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { spawn } from "node-pty";
import { ProtocolParser } from "../extensions/termia/protocol.ts";

const shellDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../extensions/termia/shell");
const identityScript = join(shellDirectory, "termia-identity.sh");

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function fixture(t: TestContext, enabled = true): { bin: string; hooks: string; log: string } {
  const root = mkdtempSync(join(tmpdir(), "termia-identity-shell-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const hooks = join(root, "hooks");
  const log = join(root, "calls.log");
  mkdirSync(bin);
  mkdirSync(hooks);
  copyFileSync(identityScript, join(hooks, "termia-identity.sh"));
  for (const name of ["termia.ash", "termia.bash", "termia.zsh"]) {
    writeFileSync(join(hooks, name), ":\n");
  }
  writeFileSync(join(hooks, "identity.pub"), enabled ? "ssh-ed25519 AAAA test\n" : "");
  for (const command of ["sudo", "su"]) {
    const path = join(bin, command);
    writeFileSync(path, `#!/bin/sh
printf '${command}' >> "$TERMIA_IDENTITY_TEST_LOG"
for value do
  printf ' %s' "$(printf '%s' "$value" | base64 | tr -d '\\n')" >> "$TERMIA_IDENTITY_TEST_LOG"
done
printf '\\n' >> "$TERMIA_IDENTITY_TEST_LOG"
exit 7
`);
    chmodSync(path, 0o700);
  }
  return { bin, hooks, log };
}

function calls(log: string): Array<{ command: string; argv: string[] }> {
  return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => {
    const [command = "", ...argv] = line.split(" ");
    return { command, argv: argv.map((value) => Buffer.from(value, "base64").toString()) };
  });
}

function runShell(command: string, env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("/bin/bash", ["--noprofile", "--norc", "-c", command], {
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      cwd: process.cwd(),
      env,
    });
    child.onExit(({ exitCode }) => resolveRun(exitCode));
    setTimeout(() => {
      child.kill();
      rejectRun(new Error("Timed out waiting for identity shell test"));
    }, 5_000).unref();
  });
}

function runShellCapture(command: string, env: NodeJS.ProcessEnv): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("/bin/bash", ["--noprofile", "--norc", "-c", command], {
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
    child.onExit(({ exitCode }) => resolveRun({ exitCode, output }));
    setTimeout(() => {
      child.kill();
      rejectRun(new Error("Timed out waiting for identity shell capture"));
    }, 5_000).unref();
  });
}

test("manages only supported no-command sudo and su forms", async (t) => {
  const { bin, hooks, log } = fixture(t);
  const script = [
    `source ${quote(identityScript)}`,
    "sudo -i",
    "sudo --shell",
    "sudo -u app --login",
    "sudo --user=app -s",
    "su -",
    "su - app",
    "su --login app",
  ].join("\n");
  await runShell(script, {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    TERMIA_PTY: "1",
    TERMIA_SSH_WORKSPACE: "1",
    TERMIA_SHELL_ID: "shell-a",
    TERMIA_HOOK_DIR: hooks,
    TERMIA_IDENTITY_TEST_LOG: log,
  });

  const invocations = calls(log);
  assert.equal(invocations.length, 7);
  for (const invocation of invocations) {
    assert.equal(invocation.argv.some((value) => value.includes("__termia_identity_bootstrap")), true);
  }
  assert.deepEqual(invocations[0]?.argv.slice(0, 1), ["-i"]);
  assert.deepEqual(invocations[4]?.argv.slice(0, 1), ["-"]);
});

test("passes unsupported sudo and su forms through unchanged", async (t) => {
  const { bin, hooks, log } = fixture(t);
  const script = [
    `source ${quote(identityScript)}`,
    "sudo apt update",
    "sudo -u app id",
    "sudo -E -i",
    "su app",
    "su - app -c id",
  ].join("\n");
  await runShell(script, {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    TERMIA_PTY: "1",
    TERMIA_SSH_WORKSPACE: "1",
    TERMIA_SHELL_ID: "shell-a",
    TERMIA_HOOK_DIR: hooks,
    TERMIA_IDENTITY_TEST_LOG: log,
  });

  assert.deepEqual(calls(log), [
    { command: "sudo", argv: ["apt", "update"] },
    { command: "sudo", argv: ["-u", "app", "id"] },
    { command: "sudo", argv: ["-E", "-i"] },
    { command: "su", argv: ["app"] },
    { command: "su", argv: ["-", "app", "-c", "id"] },
  ]);
});

test("passes user switches through when identity credentials are unavailable", async (t) => {
  const { bin, hooks, log } = fixture(t, false);
  await runShell(`source ${quote(identityScript)}\nsudo -i\nsu -`, {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    TERMIA_PTY: "1",
    TERMIA_SSH_WORKSPACE: "1",
    TERMIA_SHELL_ID: "shell-a",
    TERMIA_HOOK_DIR: hooks,
    TERMIA_IDENTITY_TEST_LOG: log,
  });
  assert.deepEqual(calls(log), [
    { command: "sudo", argv: ["-i"] },
    { command: "su", argv: ["-"] },
  ]);
});

test("installs the identity wrapper from the bash hook", async () => {
  const exitCode = await runShell(
    `source ${quote(join(shellDirectory, "termia.bash"))}\ndeclare -F sudo >/dev/null`,
    {
      ...process.env,
      TERMIA_PTY: "1",
      TERMIA_SHELL_ID: "local",
      TERMIA_HOOK_DIR: shellDirectory,
    },
  );
  assert.equal(exitCode, 0);
});

test("bootstraps an OpenSSH sidecar and target shell on the original PTY", async (t) => {
  const { bin, hooks, log } = fixture(t);
  writeFileSync(join(bin, "sudo"), `#!/bin/sh
script=
while [ "$#" -gt 0 ]; do
  case "$1" in
    */termia-identity.sh) script=$1 ;;
    __termia_identity_bootstrap) break ;;
  esac
  shift
done
[ -n "$script" ] || exit 64
exec "$script" "$@"
`);
  writeFileSync(join(bin, "ssh-keygen"), `#!/bin/sh
if [ "\${1-}" = -y ]; then
  printf 'ssh-ed25519 AAAA host\\n'
  exit 0
fi
key=
while [ "$#" -gt 0 ]; do
  if [ "$1" = -f ]; then shift; key=$1; fi
  shift
done
printf 'host-private\\n' > "$key"
printf 'ssh-ed25519 AAAA host\\n' > "$key.pub"
`);
  writeFileSync(join(bin, "sshd"), `#!/bin/sh
trap 'exit 0' TERM INT HUP
while :; do /bin/sleep 1; done
`);
  writeFileSync(join(bin, "bash"), `#!/bin/sh
printf 'TARGET:%s:%s:%s\\n' "$TERMIA_SHELL_ID" "$TERMIA_SSH_WORKSPACE" "$PWD"
exit 23
`);
  for (const command of ["sudo", "ssh-keygen", "sshd", "bash"]) {
    chmodSync(join(bin, command), 0o700);
  }

  const result = await runShellCapture(`source ${quote(identityScript)}\nsudo -i`, {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    SHELL: join(bin, "bash"),
    TERMIA_PTY: "1",
    TERMIA_SSH_WORKSPACE: "1",
    TERMIA_SHELL_ID: "shell-a",
    TERMIA_HOOK_DIR: hooks,
    TERMIA_IDENTITY_TEST_LOG: log,
  });

  assert.equal(result.exitCode, 23);
  assert.match(result.output, /TARGET:shell-a\.u1:1:/);
  const events = new ProtocolParser().push(result.output).filter((token) => token.type !== "output");
  assert.deepEqual(events.map((event) => event.type), ["identityOpen", "sshClose"]);
  assert.equal(events[0]?.type === "identityOpen" ? events[0].user : undefined, process.env.USER);
  assert.equal(events[0]?.type === "identityOpen" ? events[0].hostKey : undefined, "ssh-ed25519 AAAA");
});

test("starts Dropbear only when its isolated authorization directory is supported", async (t) => {
  const { bin, hooks, log } = fixture(t);
  writeFileSync(join(bin, "dropbear"), `#!/bin/sh
if [ "\${1-}" = -h ]; then
  printf '%s\n' '-D authorized_keys_dir' >&2
  exit 0
fi
printf '%s\n' "$*" > "$TERMIA_IDENTITY_TEST_LOG"
trap 'exit 0' TERM INT HUP
while :; do /bin/sleep 1; done
`);
  writeFileSync(join(bin, "dropbearkey"), `#!/bin/sh
if [ "\${1-}" = -y ]; then
  printf 'Public key portion is:\nssh-ed25519 AAAA dropbear\n'
  exit 0
fi
key=
while [ "$#" -gt 0 ]; do
  if [ "$1" = -f ]; then shift; key=$1; fi
  shift
done
printf 'host-private\n' > "$key"
`);
  for (const command of ["dropbear", "dropbearkey"]) {
    chmodSync(join(bin, command), 0o700);
  }
  const sftp = join(bin, "sftp-server");
  writeFileSync(sftp, "#!/bin/sh\nexit 0\n");
  chmodSync(sftp, 0o700);

  const result = await runShellCapture([
    `source ${quote(identityScript)}`,
    `__termia_identity_find_sftp() { printf '%s' ${quote(sftp)}; }`,
    'runtime=$(mktemp -d)',
    `__termia_identity_dropbear "$runtime" "$(id -un)" ${quote(hooks)}`,
    'exit_code=$?',
    'printf "PORT:%s HOST:%s\\n" "$__termia_identity_port" "$__termia_identity_host_key"',
    'kill "$__termia_identity_pid" 2>/dev/null; wait "$__termia_identity_pid" 2>/dev/null',
    'rm -rf "$runtime"',
    'exit "$exit_code"',
  ].join("\n"), {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    TERMIA_IDENTITY_TEST_LOG: log,
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.output, /PORT:\d+ HOST:ssh-ed25519 AAAA/);
  assert.match(readFileSync(log, "utf8"), /-D .*\/auth/);
});

test("keeps the switched shell unmanaged when no sidecar can start", async (t) => {
  const { bin, hooks, log } = fixture(t);
  writeFileSync(join(bin, "sudo"), `#!/bin/sh
script=
while [ "$#" -gt 0 ]; do
  case "$1" in
    */termia-identity.sh) script=$1 ;;
    __termia_identity_bootstrap) break ;;
  esac
  shift
done
exec "$script" "$@"
`);
  writeFileSync(join(bin, "sshd"), "#!/bin/sh\nexit 1\n");
  writeFileSync(join(bin, "ssh-keygen"), `#!/bin/sh
key=
while [ "$#" -gt 0 ]; do
  if [ "$1" = -f ]; then shift; key=$1; fi
  shift
done
printf 'host-private\n' > "$key"
`);
  writeFileSync(join(bin, "bash"), `#!/bin/sh
printf 'UNMANAGED:%s\n' "\${TERMIA_SHELL_ID-unset}"
exit 9
`);
  for (const command of ["sudo", "sshd", "ssh-keygen", "bash"]) {
    chmodSync(join(bin, command), 0o700);
  }

  const result = await runShellCapture(`source ${quote(identityScript)}\nsudo -i`, {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    SHELL: join(bin, "bash"),
    TERMIA_PTY: "1",
    TERMIA_SSH_WORKSPACE: "1",
    TERMIA_SHELL_ID: "shell-a",
    TERMIA_HOOK_DIR: hooks,
    TERMIA_IDENTITY_TEST_LOG: log,
  });

  assert.equal(result.exitCode, 9);
  assert.match(result.output, /managed user workspace unavailable/);
  assert.match(result.output, /UNMANAGED:unset/);
  assert.deepEqual(new ProtocolParser().push(result.output).filter((token) => token.type !== "output"), []);
});
