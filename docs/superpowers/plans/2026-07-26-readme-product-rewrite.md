# README Product Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the package README with an accurate product page that positions Termia as AI context for the user's existing terminal, then documents its real Pi, history, SSH, and managed-user workflows.

**Architecture:** `README.md` remains the single public GitHub/npm guide and the only runtime-facing file changed by implementation. The first half establishes the product thesis and demonstrates an SSH/history workflow; the second half is precise reference documentation grounded in the current extension commands and tests.

**Tech Stack:** GitHub-flavored Markdown, Pi package metadata, Node.js 24, npm

## Global Constraints

- The product and package name remains **Termia**; do not rename it to iTermia.
- The primary message is **Keep your terminal. Add AI context.**
- Termia is a Pi package, not a standalone CLI or terminal emulator.
- Keep the README in English for GitHub and npm.
- Windows Terminal support means Windows Terminal hosting WSL2, not native PowerShell or cmd.
- Public controls are `/termia`, `/termia reset`, `Ctrl+]`, `!command`, `!!command`, and `/history`.
- Do not restore the removed standalone `termia` CLI, Quick Ask, `/termia-history`, `/termia-mode`, or user-facing `termia_history` wording.
- Do not claim that Warp, Wave, or Tabby cannot use SSH or `sudo`, are universally slow, require separate paid model access, or upload all terminal data.
- Describe managed `sudo`/`su` identity tracking only inside managed SSH workspaces and only for the supported no-command forms.
- Describe PTY state as persistent only while the current Pi process is running.
- Agent Bash remains detached, concurrent, non-interactive, and outside Termia command history.
- Modify only `README.md` during implementation; the approved design and this plan are planning artifacts.
- Use the stable preview URL `https://raw.githubusercontent.com/VibeCodingStudio/Termia/main/assets/termia-preview.png`.

---

### Task 1: Rewrite and verify the public README

**Files:**
- Modify: `README.md`
- Reference: `docs/superpowers/specs/2026-07-26-readme-positioning-design.md`
- Reference: `extensions/termia/index.ts`
- Reference: `extensions/termia/history-overlay.ts`
- Reference: `extensions/termia/bang-editor.ts`
- Reference: `extensions/termia/shell/termia-ssh.sh`
- Reference: `extensions/termia/shell/termia-identity.sh`
- Test: `test/history-overlay.test.ts`
- Test: `test/bang-editor.test.ts`
- Test: `test/ssh-shell.test.ts`
- Test: `test/identity-shell.test.ts`

**Interfaces:**
- Consumes: the registered Pi commands `/termia` and `/history`, the wrapped editor controls `Ctrl+]`, `!`, and `!!`, Pi's provider configuration, and the current managed SSH/user-switch behavior.
- Produces: the complete GitHub/npm product guide packaged as `README.md`; no source-code interface changes.

- [ ] **Step 1: Run the positioning regression check and confirm the old README fails it**

Run:

```bash
rg -nF 'Keep your terminal. Add AI context.' README.md
```

Expected: exit 1 with no matches. The current README does not yet contain the approved product thesis.

- [ ] **Step 2: Replace `README.md` with the approved product guide**

Use this exact content:

````markdown
# Termia

**Keep your terminal. Add AI context.**

Termia brings [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
into the terminal you already use. Keep iTerm2, Windows Terminal through WSL2,
and the shell workflow you already trust. Termia gives Pi a real persistent
PTY, structured command history, and an Active Workspace that follows you
through local shells, nested SSH sessions, and managed `sudo`/`su` user
switches.

Use the model access already configured in Pi—your subscription, API key, or
local model. No replacement terminal, separate Termia account, or copying
terminal output into chat.

![Termia command history in a managed SSH workspace](https://raw.githubusercontent.com/VibeCodingStudio/Termia/main/assets/termia-preview.png)

## From a failed command to an answer

Start Pi and enable Termia:

```text
pi
/termia
```

Press `Ctrl+]` to enter the persistent terminal, then work normally:

```text
ssh ops@app-server
sudo -i
systemctl status nginx
```

Press `Ctrl+]` to return to Pi and open the history picker:

```text
/history
```

Select the failed command with Space, press Enter, and ask:

```text
Why did the selected command fail?
```

Termia gives Pi a compact reference to the command, workspace, cwd, exit code,
time, and duration. Pi reads the recorded output only when it needs it. There is
nothing to select with a mouse and nothing to paste into a chat box.

## Why Termia

AI-first terminals such as Warp and Wave, and replacement emulators such as
Tabby, ask you to adopt a different terminal application or integration layer.
Termia takes the opposite approach: keep the terminal, shell, and AI CLI you
already know, then make Pi aware of the environment you are actually using.

| Design choice | Replacement-terminal approach | Termia approach |
| --- | --- | --- |
| Application | Adopt a dedicated terminal application | Keep your compatible terminal emulator |
| Interaction | Use a product-specific Agent and terminal UI | Use Pi and a real persistent PTY |
| Model access | Use the product's configured AI integration | Inherit your Pi model configuration |
| History context | Use the product's capture or context workflow | Select structured `/history` references |
| Remote context | Use a product-specific remote mode | Follow managed SSH routes and supported user switches |

### Keep your terminal

Termia is a Pi package, not another terminal window. It works inside compatible
terminal emulators on Linux, macOS, and WSL2, including iTerm2 and Windows
Terminal through WSL2. It does not replace your tabs, panes, renderer, shell,
dotfiles, or keyboard habits.

### Keep a real shell

Termia runs a real interactive PTY. Its current foreground shell retains cwd,
environment variables, aliases, functions, and jobs while Pi is running.
Passwords, confirmations, `/dev/tty`, full-screen tools, native SSH, and native
`sudo` remain ordinary terminal interactions rather than chat abstractions.

### Keep the real workspace

In a managed SSH session, Pi's file tools, project resources, and Agent Bash
follow the committed Active Workspace. Nested hops keep their real route. After
a supported managed user switch, Pi follows the effective remote user too.
Termia fails closed instead of silently sending an Agent operation to the wrong
host, directory, or identity.

### Keep history without copy-paste

`/history` lets you select previous commands while keeping full terminal output
out of the prompt. Pi receives small, stable references and retrieves only the
output needed for the current question.

### Keep your model access

Termia inherits Pi's authentication and model selection. Use a subscription,
API key, custom provider, or local model supported by your Pi setup. Termia does
not add another AI account, proxy, credit balance, or model plan.

## Install

Install Pi, then install Termia from npm:

```bash
npm install -g @earendil-works/pi-coding-agent
pi install npm:@vibecodingstudio/termia
```

If Pi does not already have model access configured, run `pi` and use `/login`.
Use Pi's `/model` command to choose among the models available to your current
provider configuration.

Termia requires Node.js 22.19 or newer. Managed SSH file access also requires
SSHFS on the machine running Pi and SFTP on the remote host. On Linux, install
both `sshfs` and `fusermount3`; on macOS, install a compatible SSHFS
implementation.

To install from source:

```bash
npm install
pi install ./
```

## Quick start

Start `pi` in a persisted session. Termia starts disabled in every Pi process.

```text
/termia           enable or disable Termia
/termia reset     confirm and replace the terminal with a fresh local runtime
Ctrl+]            switch between Agent and PTY while the Agent is idle
!command          run in the current foreground shell and add result context
!!command         run in the current foreground shell without result context
/history          browse and select recorded command history
```

Enabling Termia creates a fresh Pi conversation for terminal-aware work and
remembers the conversation you came from. Running `/termia` again disables the
mode and returns to that original conversation.

The terminal prompt begins with `[termia]`. Press `Ctrl+]` while the Agent is
idle to move between Pi and the terminal without stopping the shell or losing
an unfinished Pi draft. While the Agent is running, the shortcut is consumed
instead of being queued for a later switch.

## History without copy-paste

Termia records ordinary interactive commands with their cwd, exit code, time,
duration, output, and workspace. Commands submitted with `!` and `!!` are also
recorded. Managed `ssh`, `sudo`, and `su` transitions may be consumed as
workspace events rather than ordinary history entries.

Open `/history` to inspect the most recent commands:

- Up/Down moves through commands.
- Space selects or deselects commands.
- Pi's tool-output expansion key (`Ctrl+O` by default) previews the active
  command's output.
- Enter inserts compact references for the selected commands into the Pi
  editor.
- Escape closes the picker.

The references include stable command indexes and execution metadata, not the
full transcript. Pi can retrieve the corresponding output on demand, so long
logs do not have to be copied into the conversation.

## Persistent PTY and Agent Bash

Manual terminal commands, `!`, and `!!` use the same persistent PTY and current
foreground shell. Local, remote, and switched-user shells can therefore keep
their own cwd, variables, aliases, functions, and jobs while they remain
active. Re-entering the terminal replays a bounded tail of its recorded output
before live output resumes.

Agent Bash is deliberately different. It runs as a detached, concurrent,
non-interactive job in the Active Workspace. It does not inherit process-local
aliases, functions, unexported variables, or jobs, and its commands are not
added to Termia history.

Because Agent Bash has no interactive input or controlling terminal, commands
that require a password, confirmation, or `/dev/tty` fail normally instead of
blocking. Use the persistent terminal for interactive authentication, package
upgrades, full-screen programs, and other prompts.

The PTY and its process-local state live for the current Pi process. Recorded
history survives on disk, but Termia does not promise to restore running jobs or
shell state after Pi exits or crashes.

## Managed SSH workspaces

From the persistent terminal, a supported plain interactive `ssh host` becomes
a managed workspace. `ssh -4`, `ssh -6`, `-p`, `-l`, and `--` are supported.
Remote commands, tunnels, and unsupported advanced forms keep their native SSH
behavior but do not become managed workspaces.

Managed hops can nest, for example `local -> bastion -> app -> database`. Each
hop runs through its immediate parent, so credentials for deeper hosts stay on
the machine that owns them. Pressing `Ctrl+]` returns to Pi without closing the
SSH chain. Pi's file tools, `@file`, project resources, and detached Agent Bash
then operate on the active remote workspace, shown with a logical cwd such as:

```text
ssh://ops@app-server/srv/app
```

SSH file access requires SSHFS locally and SFTP remotely. If that file path
cannot be prepared, the interactive SSH shell can continue, but Termia does not
expose the failed remote workspace to Pi. Password-authenticated SSH remains
interactive; Termia never stores or replays passwords.

Termia does not automatically reconnect a dropped SSH route. Return to a live
parent in the terminal and reconnect manually. Exiting SSH returns through the
retained parent hops and finally to the local directory that was active before
the first hop.

### Managed remote user switches

Inside a managed SSH workspace, Termia can also follow these interactive,
no-command user switches:

```text
sudo -i
sudo -s
sudo -u app -i
sudo --user=app --shell
su -
su - app
su --login app
```

After a supported switch, history and the Active Workspace follow the target
shell. Pi's file tools, `@file`, and detached Agent Bash use the effective remote
user. Exiting the switched shell restores the exact parent SSH workspace, and
managed switches can nest with SSH hops.

Other forms—including `sudo command`, `sudo -u app command`, `sudo -E -i`,
`su app`, and `su - app -c command`—run with their native `sudo` or `su`
behavior and do not create a managed user workspace. A local interactive
`sudo -i` remains usable in the terminal, but Termia does not expose it to Pi as
a managed root workspace.

Managed remote user switching requires a usable system OpenSSH server and
`ssh-keygen`, or a compatible Dropbear build and `dropbearkey`, on the remote
host. SFTP must also be available. Termia uses an ephemeral, password-disabled,
loopback-only sidecar and does not modify a permanent `authorized_keys` file. If
the required capabilities are unavailable, the switched shell remains usable
interactively but Pi stays in the previous Active Workspace.

## Workspace safety and recovery

Agent actions follow the committed Active Workspace, not every transient shell
transition. A route, mount, or Pi session-handoff failure leaves the new
environment Pending while Agent operations stay in the previous Active
Workspace.

If a remote Active Workspace becomes unavailable, Termia retains its host and
user identity and blocks affected remote file and Bash operations. It never
silently falls back to a different host or reconnects with guessed credentials.

`/termia reset` is the explicit last-resort recovery action. After confirmation,
it stages a fresh local terminal and Pi session, switches only after the new
runtime is ready, then discards the previous PTY and managed SSH chain. Reset is
never automatic and loses running terminal jobs and process-local shell state.

## Requirements and limits

- Node.js 22.19 or newer
- Linux, WSL2, or macOS
- Pi TUI mode with a persisted session
- bash, zsh, BusyBox ash, or BusyBox sh as the interactive shell
- SSHFS locally and SFTP remotely for managed SSH file access
- `fusermount3` on Linux for managed SSH mounts
- Remote OpenSSH or a compatible Dropbear setup for managed remote `sudo`/`su`
  workspaces

## Storage

Termia stores its data under Pi's agent directory:

```text
~/.pi/agent/termia/history.db        command metadata
~/.pi/agent/termia/transcripts/      recorded terminal output
~/.pi/agent/termia/pi-sessions/      Termia Pi sessions
~/.pi/agent/termia/retired/          superseded sessions
```

Setting `PI_CODING_AGENT_DIR` moves the complete `termia/` tree with Pi's agent
configuration.

## Security

Pi packages execute local code. Termia starts an interactive shell, records
terminal output, and can expose remote files to Pi through managed SSH
workspaces. Install it only from a source you trust. Before approving changes,
verify the Active Workspace host, user, and directory, and review destructive
commands carefully.

## Uninstall

```bash
pi remove npm:@vibecodingstudio/termia
```

## License

MIT
````

- [ ] **Step 3: Run the README content-contract checks**

Run:

```bash
rg -nF 'Keep your terminal. Add AI context.' README.md
rg -nF 'Windows Terminal through WSL2' README.md
rg -nF '/termia reset' README.md
rg -nF 'Ctrl+]' README.md
rg -nF '!command' README.md
rg -nF '!!command' README.md
rg -nF '/history' README.md
rg -nF 'sudo -u app -i' README.md
rg -nF 'su --login app' README.md
```

Expected: every command exits 0 and reports at least one matching line.

Run:

```bash
if rg -n -i -- 'quick[- ]?ask|/termia-history|/termia-mode|termia_history|termia "|h~[0-9]|--last|--all|--attach|--model|--tools' README.md; then
  exit 1
fi
```

Expected: exit 0 with no output.

- [ ] **Step 4: Cross-check the documented commands against the current extension**

Run:

```bash
rg -n 'registerCommand\("termia"|args\.trim\(\) === "reset"' extensions/termia/index.ts
rg -n 'registerCommand\("history"' extensions/termia/history-overlay.ts
rg -n 'parseTermiaInvocation|ctrl\+\]' extensions/termia/bang-editor.ts test/bang-editor.test.ts
rg -n 'sudo -u app --login|su --login app' test/identity-shell.test.ts
```

Expected: all four commands exit 0 and show the implementation or regression
coverage for every public control and managed-user example in the README.

- [ ] **Step 5: Run Markdown and repository verification**

Run:

```bash
git diff --check -- README.md
npm run typecheck
npm test
```

Expected:

- `git diff --check -- README.md` exits 0 with no output.
- `npm run typecheck` exits 0.
- `npm test` exits 0 with 167 tests total, 163 passed, 4 skipped, and 0 failed
  in the current environment.

- [ ] **Step 6: Verify the publishable package contains the rewritten guide and preview**

Run:

```bash
npm pack --dry-run --json | node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const paths = JSON.parse(input)[0].files.map(file => file.path);
  for (const required of ["README.md", "assets/termia-preview.png"]) {
    if (!paths.includes(required)) throw new Error(`missing ${required}`);
  }
  console.log("README.md and assets/termia-preview.png are publishable");
});
'
```

Expected: exit 0 and print:

```text
README.md and assets/termia-preview.png are publishable
```

- [ ] **Step 7: Review and commit only the README rewrite**

Run:

```bash
git diff -- README.md
git status --short
git add README.md
git diff --cached --check
git diff --cached --name-status
git commit -m "docs: reposition README around existing terminals"
```

Expected before the commit:

```text
M	README.md
```

Expected after the commit: one new documentation commit containing only
`README.md`. Do not push unless the user asks.
