import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ASSETS = [
  "termia.ash",
  "termia.bash",
  "termia.zsh",
  "termia-ssh.sh",
  "termia-identity.sh",
];

export type IdentityRuntime = {
  hookDirectory: string;
  privateKey: string | undefined;
  publicKey: string | undefined;
  dispose(): void;
};

export function createIdentityRuntime(sourceDirectory: string): IdentityRuntime {
  const hookDirectory = mkdtempSync(join(tmpdir(), "termia-hooks-"));
  chmodSync(hookDirectory, 0o700);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    rmSync(hookDirectory, { recursive: true, force: true });
  };

  try {
    for (const asset of ASSETS) {
      copyFileSync(join(sourceDirectory, asset), join(hookDirectory, asset));
    }
    const privateKey = join(hookDirectory, "identity");
    const publicKey = `${privateKey}.pub`;
    const generated = spawnSync(
      "ssh-keygen",
      ["-q", "-t", "ed25519", "-N", "", "-f", privateKey],
      { stdio: "ignore" },
    );
    if (generated.status === 0 && existsSync(privateKey) && existsSync(publicKey)) {
      chmodSync(privateKey, 0o600);
      chmodSync(publicKey, 0o600);
      return { hookDirectory, privateKey, publicKey, dispose };
    }
    rmSync(privateKey, { force: true });
    writeFileSync(publicKey, "", { mode: 0o600 });
    return { hookDirectory, privateKey: undefined, publicKey: undefined, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
