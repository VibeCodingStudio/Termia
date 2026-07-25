# Managed sudo and su workspaces implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make supported `sudo -i`, `sudo -s`, and login `su` shells behave as managed nested workspaces whose terminal, cwd, history, file tools, and concurrent Agent Bash operations use the switched identity.

**Architecture:** Keep the switched shell on the existing PTY, but start a loopback-only OpenSSH or Dropbear sidecar under the target identity. A per-terminal local SSH key opens a local ControlMaster through the current SSH route; that ControlMaster becomes a new local route anchor in the existing workspace stack.

**Tech Stack:** TypeScript, Node.js 22 standard library, POSIX shell compatible with bash/zsh/BusyBox ash, OpenSSH, Dropbear, SSHFS, Node test runner.

## Global constraints

- Do not add an npm dependency or ship a privileged helper binary.
- Keep Agent Bash detached, concurrent, non-interactive, and absent from Termia history.
- Keep the foreground switched shell on the original PTY; do not replace it with an SSH login.
- Keep the private identity key on the Pi machine and listen only on remote loopback.
- Do not install packages or modify permanent SSH, sudoers, profile, or `authorized_keys` files.
- Unsupported command forms and unsupported remote capabilities must retain native `sudo` or `su` behavior.
- Never route a requested privileged operation through the original unprivileged SSH identity.
- Limit the first release to supported user-switch forms inside an active managed SSH workspace.

---

### Task 1: Identity protocol events

**Files:**
- Modify: `extensions/termia/protocol.ts`
- Modify: `test/protocol.test.ts`

**Interfaces:**
- Produces: `IdentityOpenEvent` with `type`, `parentShellId`, `shellId`, `user`, `cwd`, `port`, and `hostKey`.
- Produces: protocol tag `U` for identity-open; existing tag `L` remains the common shell-close event.

- [ ] **Step 1: Write failing parser tests**

Add tests that parse a valid frame and reject invalid ports, relative cwd values, empty users, malformed host keys, and unexpected field counts:

```ts
const frame = osc("U", ["parent", "parent.1", "root", "/root", "45123", "ssh-ed25519 AAAA..."]);
assert.deepEqual(tokens(frame)[0], {
  type: "identityOpen",
  parentShellId: "parent",
  shellId: "parent.1",
  user: "root",
  cwd: "/root",
  port: 45123,
  hostKey: "ssh-ed25519 AAAA...",
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `node --test test/protocol.test.ts`

Expected: FAIL because `U` frames are currently returned as output.

- [ ] **Step 3: Add the protocol type and validation**

Add this public type and include it in `ProtocolToken`:

```ts
export type IdentityOpenEvent = {
  type: "identityOpen";
  parentShellId: string;
  shellId: string;
  user: string;
  cwd: string;
  port: number;
  hostKey: string;
};
```

Decode textual fields with `decodedText`, cwd with `decodedAbsolutePath`, require ports `1..65535`, and accept host keys only when they match `^(ssh-ed25519|ecdsa-sha2-[^ ]+|ssh-rsa) [A-Za-z0-9+/]+={0,2}$`.

- [ ] **Step 4: Run the focused test and verify pass**

Run: `node --test test/protocol.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the protocol slice**

```bash
git add extensions/termia/protocol.ts test/protocol.test.ts
git commit -m "feat: parse managed identity events"
```

### Task 2: Local route anchors

**Files:**
- Modify: `extensions/termia/workspace.ts`
- Modify: `extensions/termia/ssh-workspace.ts`
- Modify: `test/workspace.test.ts`
- Modify: `test/ssh-workspace.test.ts`

**Interfaces:**
- Produces: optional `localAnchor?: true` on `SshHop`.
- Produces: `activeRoute(hops: readonly SshHop[]): readonly SshHop[]`.
- Produces: `buildRemoteStreamCommand(hops, host, port): string` for ProxyCommand transport.
- Existing `buildRemoteExecCommand`, `buildRemoteBashCommand`, `buildSftpBridgeScript`, and control close operations consume only the active route beginning at its newest local anchor.

- [ ] **Step 1: Write failing route tests**

Create a chain representing `local -> SSH A -> root@A anchor -> SSH B` and assert that generated commands start at the root anchor, include B, and omit the superseded unprivileged A control socket:

```ts
const route = activeRoute([sshA, { ...rootA, localAnchor: true }, sshB]);
assert.deepEqual(route.map((hop) => hop.shellId), [rootA.shellId, sshB.shellId]);
assert.doesNotMatch(buildRemoteExecCommand([sshA, rootA, sshB], "id -un"), /ssh-a-control/);
assert.match(buildRemoteExecCommand([sshA, rootA, sshB], "id -un"), /identity-control/);
```

Also assert that normal legacy chains remain byte-for-byte unchanged and that `buildRemoteStreamCommand` ends in `ssh -W '127.0.0.1:45123'` on the current leaf.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node --test test/workspace.test.ts test/ssh-workspace.test.ts`

Expected: FAIL because identity anchors and stream routes do not exist.

- [ ] **Step 3: Implement minimal route selection**

Add `localAnchor?: true` to `SshHop`. Mark the first ordinary managed SSH hop as an anchor when `SshChain.open()` receives it. Select the final `localAnchor` index, defaulting to index zero for legacy fixtures:

```ts
export function activeRoute(hops: readonly SshHop[]): readonly SshHop[] {
  let start = 0;
  for (let index = 0; index < hops.length; index += 1) {
    if (hops[index]?.localAnchor === true) start = index;
  }
  return hops.slice(start);
}
```

Apply this once at the start of every exec, SFTP, stream, and control-close command builder. Do not change URI or mount naming; those continue to use the complete logical chain.

- [ ] **Step 4: Run focused tests and verify pass**

Run: `node --test test/workspace.test.ts test/ssh-workspace.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the routing slice**

```bash
git add extensions/termia/workspace.ts extensions/termia/ssh-workspace.ts test/workspace.test.ts test/ssh-workspace.test.ts
git commit -m "feat: support local ssh route anchors"
```

### Task 3: Per-terminal identity credentials

**Files:**
- Create: `extensions/termia/identity-runtime.ts`
- Modify: `extensions/termia/terminal.ts`
- Create: `test/identity-runtime.test.ts`
- Modify: `test/terminal.test.ts`

**Interfaces:**
- Produces: `createIdentityRuntime(sourceDirectory: string): IdentityRuntime`.
- `IdentityRuntime` exposes `hookDirectory`, `privateKey`, `publicKey`, and `dispose()`.
- `privateKey` and `publicKey` are `undefined` when `ssh-keygen` is unavailable; ordinary Termia and SSH behavior must still start.

- [ ] **Step 1: Write failing runtime tests**

Use a temporary fake `ssh-keygen` to assert copied hook assets, mode `0700` on the directory, `0600` on the private key, and removal on `dispose()`. Add a missing-command case that returns an identity-disabled runtime without throwing.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node --test test/identity-runtime.test.ts test/terminal.test.ts`

Expected: FAIL because `identity-runtime.ts` does not exist.

- [ ] **Step 3: Implement the runtime with Node standard library**

Use `mkdtempSync`, `cpFileSync`, `chmodSync`, `spawnSync`, and `rmSync`. Copy these assets into the runtime directory:

```ts
const ASSETS = [
  "termia.ash",
  "termia.bash",
  "termia.zsh",
  "termia-ssh.sh",
];
```

Run `ssh-keygen -q -t ed25519 -N "" -f <runtime>/identity` and keep the private path only in `TerminalController`. Pass the runtime directory as `TERMIA_HOOK_DIR`. Create an empty `identity.pub` when key generation is unavailable so later SSH staging remains deterministic.

- [ ] **Step 4: Dispose credentials with the terminal**

Call `IdentityRuntime.dispose()` from every `TerminalController.finish()` and `dispose()` path after SSH workspaces close. Never delete the package source directory.

- [ ] **Step 5: Run focused tests and verify pass**

Run: `node --test test/identity-runtime.test.ts test/terminal.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the credential slice**

```bash
git add extensions/termia/identity-runtime.ts extensions/termia/terminal.ts test/identity-runtime.test.ts test/terminal.test.ts
git commit -m "feat: create ephemeral identity credentials"
```

### Task 4: sudo and su shell wrapper

**Files:**
- Create: `extensions/termia/shell/termia-identity.sh`
- Modify: `extensions/termia/identity-runtime.ts`
- Modify: `extensions/termia/shell/termia.bash`
- Modify: `extensions/termia/shell/termia.zsh`
- Modify: `extensions/termia/shell/termia.ash`
- Modify: `extensions/termia/shell/termia-ssh.sh`
- Create: `test/identity-shell.test.ts`

**Interfaces:**
- Produces shell functions `sudo()` and `su()` only while Termia hooks are active.
- Produces `__termia_identity_emit_open(parent, child, user, cwd, port, host_key)`.
- Consumes `TERMIA_HOOK_DIR/identity.pub`; an empty or missing key forces native pass-through.
- Reuses existing `L` shell-close emission after the managed target shell exits.

- [ ] **Step 1: Write failing parser and pass-through tests**

Fake `sudo` and `su` executables must log argv. Verify management only for the exact no-command families from the design. Verify these remain byte-for-byte native calls:

```text
sudo apt update
sudo -u app id
sudo -E -i
su app
su - app -c id
command sudo -i
/usr/bin/sudo -i
```

- [ ] **Step 2: Run the shell test and verify failure**

Run: `node --test test/identity-shell.test.ts`

Expected: FAIL because the wrapper does not exist.

- [ ] **Step 3: Implement conservative POSIX-compatible argument parsing**

Parse only `-i|--login` or `-s|--shell`, optional `-u USER|--user USER|--user=USER`, and no command for sudo. Parse only `-|--login` plus zero or one username for su. Delegate every other shape through `command sudo "$@"` or `command su "$@"` without normalization.

Add `termia-identity.sh` to `IdentityRuntime`'s copied asset list, source it from every supported shell hook, and include it plus `identity.pub` in the managed SSH tar asset list.

- [ ] **Step 4: Add target bootstrap and OpenSSH adapter**

The wrapper creates a readable, non-writable staging directory under `/tmp`, copies the shell hooks and public key, and appends a bootstrap invocation to the real sudo/su command. The target bootstrap:

```sh
umask 077
runtime=$(mktemp -d "${TMPDIR:-/tmp}/termia-identity.XXXXXXXX") || exit 1
trap '__termia_identity_cleanup' EXIT HUP INT TERM
target_user=$(id -un) || exit 1
target_cwd=$PWD
target_shell=${SHELL:-/bin/sh}
```

For OpenSSH, generate an ephemeral Ed25519 host key and a config with `ListenAddress 127.0.0.1`, `PasswordAuthentication no`, `KbdInteractiveAuthentication no`, `UsePAM no`, `AllowUsers <target>`, `PermitUserRC no`, forwarding disabled, and `Subsystem sftp internal-sftp`. Start `/usr/sbin/sshd -D -e -f <config>` on up to 16 deterministic high-port candidates derived from `$$`, rejecting every failed bind.

- [ ] **Step 5: Add the Dropbear adapter**

Select Dropbear only when `dropbear -h` advertises `-D` and a working SFTP server exists in `/usr/libexec/sftp-server`, `/usr/lib/openssh/sftp-server`, or `/usr/lib/ssh/sftp-server`. Generate a host key with `dropbearkey`, use the staged key through `-D <auth-dir>`, bind `127.0.0.1:<port>`, disable passwords and forwarding, set an idle timeout, and keep the server in the foreground under the bootstrap supervisor.

- [ ] **Step 6: Launch the target shell and emit lifecycle events**

After the sidecar survives its bind probe, emit `U`, launch the target bash/zsh/ash interactively with the same login-versus-shell mode and cwd established by sudo/su, source the user's normal startup file followed by the Termia hook, wait for it, emit `L`, and return its exact exit status. If capability setup fails, print one warning and continue with the target shell without emitting `U`.

- [ ] **Step 7: Run shell tests across available shells**

Run: `node --test test/identity-shell.test.ts test/ssh-shell.test.ts`

Expected: PASS; zsh/ash cases may use existing conditional skips when those shells are not installed.

- [ ] **Step 8: Commit the wrapper slice**

```bash
git add extensions/termia/identity-runtime.ts extensions/termia/shell/termia-identity.sh extensions/termia/shell/termia.bash extensions/termia/shell/termia.zsh extensions/termia/shell/termia.ash extensions/termia/shell/termia-ssh.sh test/identity-shell.test.ts test/ssh-shell.test.ts
git commit -m "feat: manage sudo and su shells"
```

### Task 5: Identity ControlMaster and workspace lifecycle

**Files:**
- Modify: `extensions/termia/ssh-workspace.ts`
- Modify: `extensions/termia/terminal.ts`
- Modify: `test/ssh-workspace.test.ts`
- Modify: `test/terminal.test.ts`

**Interfaces:**
- Produces: `IdentityTransport.open(event, parentHops, privateKey): Promise<SshHop>`.
- Produces: `IdentityTransport.close(shellId): Promise<void>` and `dispose(): Promise<void>`.
- `SshChain.openIdentity(event, privateKey)` pushes a pending hop whose `mountTask` first opens the transport and then mounts SSHFS.

- [ ] **Step 1: Write failing transport tests**

Fake local `ssh` and assert that identity opening creates a mode-`0700` runtime directory, a ProxyCommand bridge using `buildRemoteStreamCommand`, a known-hosts file containing the event host key, and this master shape:

```text
ssh -M -S <control> -o ControlMaster=yes -o ControlPersist=no
  -o ProxyCommand=<bridge> -o IdentitiesOnly=yes -i <private>
  -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no
  -o HostKeyAlias=<identity-alias> -o UserKnownHostsFile=<known-hosts>
  -fN root@<identity-alias>
```

Assert returned hops have `localAnchor: true`, logical `user` equal to the target identity, and logical `host`/`port` inherited from the parent SSH leaf.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node --test test/ssh-workspace.test.ts test/terminal.test.ts`

Expected: FAIL because identity transport and controller handling do not exist.

- [ ] **Step 3: Implement IdentityTransport**

Use existing argv validation, local command checks, bounded process timeouts, and runtime cleanup patterns. Write the bridge and known-hosts files with modes `0700` and `0600`. Do not put the private key, username, or dynamic shell text into an unquoted command string.

- [ ] **Step 4: Add pending identity hops to SshChain**

Keep the complete logical chain for URI/history, but use the identity hop as the newest local route anchor. On transport or mount error retain the hop error for `readyBinding()` while `nearestLiveBinding()` returns the parent. Close order is mount, identity ControlMaster, then runtime files.

- [ ] **Step 5: Handle identity events in TerminalController**

On `identityOpen`, validate that the active workspace is SSH and a private key exists, call `openIdentity`, register `shellParents`, and update the active shell/cwd exactly as `sshOpen` does. On `L`, close either ordinary SSH or identity state through the common SshChain lifecycle. Warning output must not expose key material or raw generated commands.

- [ ] **Step 6: Run focused tests and verify pass**

Run: `node --test test/ssh-workspace.test.ts test/terminal.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the workspace slice**

```bash
git add extensions/termia/ssh-workspace.ts extensions/termia/terminal.ts test/ssh-workspace.test.ts test/terminal.test.ts
git commit -m "feat: bind agent tools to switched users"
```

### Task 6: End-to-end OpenSSH identity test

**Files:**
- Modify: `test/integration/ssh/Dockerfile`
- Modify: `test/integration/ssh/entrypoint.sh`
- Modify: `test/ssh-integration.test.ts`

**Interfaces:**
- Consumes the public `/termia` behavior only: persistent PTY commands, workspace binding, file mount, and `createModeBashOperations`.

- [ ] **Step 1: Extend the fixture**

Install `sudo`, create users `termia` and `app`, add a fixture-only `NOPASSWD` sudo policy for switching to root/app, and create identity-owned marker files:

```text
/root/root-only.txt
/home/app/app-only.txt
```

Keep production code password-agnostic; the policy is only for deterministic integration tests.

- [ ] **Step 2: Write the failing identity-chain integration test**

Extend the existing chain test to execute:

```text
SSH host-a -> sudo -i -> cd /root -> SSH host-b -> sudo -u app -i
```

Assert logical URIs, mounted file ownership/access, `id -un` from two concurrent Agent Bash calls, cwd synchronization after `cd`, target history attribution, and exact restoration after each `exit`.

- [ ] **Step 3: Run the integration test and verify failure**

Run: `TERMIA_SSH_INTEGRATION=1 node --test test/ssh-integration.test.ts`

Expected: FAIL at the first identity workspace assertion before the remaining implementation is complete.

- [ ] **Step 4: Fix only integration-discovered defects**

Adjust lifecycle ordering, quoting, server readiness, and fixture configuration only where the real OpenSSH test demonstrates a mismatch. Do not broaden command parsing or add retries beyond the bounded values in the design.

- [ ] **Step 5: Run the integration test and verify pass**

Run: `TERMIA_SSH_INTEGRATION=1 node --test test/ssh-integration.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the integration slice**

```bash
git add test/integration/ssh/Dockerfile test/integration/ssh/entrypoint.sh test/ssh-integration.test.ts
git commit -m "test: cover managed sudo workspaces"
```

### Task 7: Documentation and release-quality verification

**Files:**
- Modify: `README.md`
- Modify: `package.json` only if a new shell asset is missing from `npm pack`; do not change the package version.

**Interfaces:**
- Documents supported command forms, effective-user URI behavior, dependencies, security lifetime, pass-through forms, and unmanaged fallback.

- [ ] **Step 1: Update README behavior and limits**

Add one subsection under managed SSH workspaces with examples for `sudo -i`, `sudo -s`, and `su -`; state that Agent tools follow the switched identity only while the sidecar is healthy. Document OpenSSH/Dropbear and SFTP requirements plus native fallback.

- [ ] **Step 2: Run complete verification**

Run:

```bash
npm run typecheck
npm test
TERMIA_SSH_INTEGRATION=1 node --test test/ssh-integration.test.ts
npm pack --dry-run
git diff --check
```

Expected: typecheck succeeds; all non-skipped tests pass; the integration test passes; the dry-run contains `termia-identity.sh`; diff check emits no output.

- [ ] **Step 3: Perform manual capability tests**

On the available Linux OpenSSH, macOS OpenSSH, and OpenWrt Dropbear hosts, verify supported command entry, cwd sync, read/edit, two concurrent Agent Bash commands, nested SSH, normal exit restoration, and forced disconnect cleanup. Record an explicit skip in the final handoff for any unavailable physical platform; do not claim it was tested.

- [ ] **Step 4: Commit documentation**

```bash
git add README.md package.json
git commit -m "docs: explain managed user workspaces"
```

- [ ] **Step 5: Inspect final scope**

Run:

```bash
git status --short
git log --oneline --decorate -8
git diff HEAD~7..HEAD --stat
```

Expected: only the design, plan, implementation, tests, fixture, and README changes are present; no package version change or npm publication occurred.
