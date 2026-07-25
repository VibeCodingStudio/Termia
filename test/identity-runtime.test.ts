import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createIdentityRuntime } from "../extensions/termia/identity-runtime.ts";

const assets = ["termia.ash", "termia.bash", "termia.zsh", "termia-ssh.sh"];

function sourceFixture(root: string): string {
  const source = join(root, "source");
  mkdirSync(source);
  for (const asset of assets) writeFileSync(join(source, asset), `${asset}\n`);
  return source;
}

test("creates private per-terminal hooks and an SSH identity", (t) => {
  const root = mkdtempSync(join(tmpdir(), "termia-identity-runtime-test-"));
  const source = sourceFixture(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const keygen = join(bin, "ssh-keygen");
  writeFileSync(keygen, `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = -f ]; then
    shift
    key=$1
  fi
  shift
done
printf 'private-key\\n' > "$key"
printf 'ssh-ed25519 AAAA test\\n' > "$key.pub"
`);
  chmodSync(keygen, 0o700);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  });

  const runtime = createIdentityRuntime(source);
  const hookDirectory = runtime.hookDirectory;
  assert.equal(statSync(hookDirectory).mode & 0o777, 0o700);
  for (const asset of assets) {
    assert.equal(readFileSync(join(hookDirectory, asset), "utf8"), `${asset}\n`);
  }
  assert.equal(runtime.privateKey, join(hookDirectory, "identity"));
  assert.equal(runtime.publicKey, join(hookDirectory, "identity.pub"));
  assert.equal(statSync(runtime.privateKey!).mode & 0o777, 0o600);

  runtime.dispose();
  assert.equal(existsSync(hookDirectory), false);
});

test("keeps ordinary shell hooks available without ssh-keygen", (t) => {
  const root = mkdtempSync(join(tmpdir(), "termia-identity-runtime-no-key-"));
  const source = sourceFixture(root);
  const bin = join(root, "empty-bin");
  mkdirSync(bin);
  const previousPath = process.env.PATH;
  process.env.PATH = bin;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  });

  const runtime = createIdentityRuntime(source);
  const hookDirectory = runtime.hookDirectory;
  assert.equal(runtime.privateKey, undefined);
  assert.equal(runtime.publicKey, undefined);
  assert.equal(readFileSync(join(hookDirectory, "identity.pub"), "utf8"), "");
  assert.equal(readFileSync(join(hookDirectory, "termia.bash"), "utf8"), "termia.bash\n");

  runtime.dispose();
  assert.equal(existsSync(hookDirectory), false);
});
