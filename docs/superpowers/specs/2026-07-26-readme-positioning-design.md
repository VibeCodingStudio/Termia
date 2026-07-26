# README Product Positioning Design

## Goal

Rewrite `README.md` as the public product page for Termia. The README must lead
with the reason Termia exists, show its real workflow, and retain enough precise
reference material for users to install and operate it safely.

The rewrite changes documentation only. It does not rename the package, add a
standalone CLI, or change runtime behavior.

## Product Thesis

Termia is not a terminal emulator. It is a Pi package that brings AI into the
terminal and shell workflow the user already trusts.

The primary message is:

> **Keep your terminal. Add AI context.**

Users can keep iTerm2, Windows Terminal through WSL2, or another compatible
terminal emulator. Termia adds a persistent interactive PTY, structured command
history, and an Active Workspace that follows the foreground environment across
local work, nested managed SSH sessions, and supported managed `sudo`/`su` user
switches.

Termia inherits the provider, subscription, API-key, or local-model setup already
configured in Pi. It does not introduce a Termia account, model plan, or credit
system.

## Audience

The README is for developers and operators who:

- already have a terminal and shell workflow they do not want to replace;
- want an AI coding agent without adopting a new terminal interaction model;
- work locally and through SSH, including nested hops;
- use interactive password prompts, full-screen terminal programs, `sudo`, or
  `su`;
- want an Agent to diagnose previous commands without copying terminal output
  into chat; and
- want to use model access already configured through Pi.

## Positioning Against Replacement Terminals

The README will describe a design contrast, not make categorical attacks on
specific products.

Warp and Wave build their own terminal applications around integrated Agent,
block, widget, and graphical workflows. Tabby is a configurable replacement
terminal emulator and SSH client whose AI integrations are external plugins.
Those approaches can be useful, but they require adopting the product's terminal
application and interaction layer.

Termia takes the opposite approach: preserve the existing emulator, real shell,
and ordinary terminal operations, then make Pi aware of that environment.

The README will mention Warp, Wave, and Tabby only in one category-setting
sentence: AI-first terminals such as Warp and Wave, and replacement emulators
such as Tabby, ask users to adopt a different terminal application or integration
layer. The durable comparison then uses only the neutral labels
“replacement-terminal approach” and “Termia approach.” It must not claim that
competitors cannot use SSH or `sudo`, are universally slow, force a separate
paid model subscription, or upload all terminal data.

The compact comparison covers stable design choices only:

| Design choice | Replacement-terminal approach | Termia approach |
| --- | --- | --- |
| Application | Adopt a dedicated terminal application | Keep the current compatible emulator |
| Interaction | Use a product-specific Agent and terminal UI | Use Pi and a real persistent PTY |
| Model access | Use the product's configured AI integration | Inherit the user's Pi model configuration |
| History context | Use the product's capture or context workflow | Select structured `/history` references |
| Remote context | Use a product-specific remote mode | Follow managed SSH routes and supported user switches |

Useful primary references for maintaining accurate wording:

- [Warp feature support over SSH](https://docs.warp.dev/code/ssh-feature-support)
- [Warp SSH and Warpify](https://docs.warp.dev/terminal/warpify/ssh)
- [Wave AI](https://docs.waveterm.dev/waveai)
- [Wave remote connections](https://docs.waveterm.dev/connections)
- [Tabby: what it is and is not](https://github.com/Eugeny/tabby#what-tabby-is-and-isnt)

## Opening

The README remains English-language documentation for GitHub and npm. The brand
name remains **Termia**.

The opening should communicate the product in one screen:

```markdown
# Termia

**Keep your terminal. Add AI context.**

Termia brings Pi into the terminal you already use. Keep iTerm2, Windows
Terminal through WSL2, and the shell workflow you already trust. Termia gives
Pi a real persistent PTY, structured command history, and an Active Workspace
that follows you through local shells, nested SSH sessions, and managed
`sudo`/`su` user switches.

Use the model access already configured in Pi—your subscription, API key, or
local model. No replacement terminal, separate Termia account, or copying
terminal output into chat.
```

The existing history preview remains directly below the opening.

## Demonstration Story

The first workflow should be a short, accurate operator story rather than the
removed standalone `termia` CLI examples:

```text
pi
/termia
Ctrl+]

ssh ops@app-server
sudo -i
systemctl status nginx

Ctrl+]
/history
```

The accompanying text explains that the user selects the failed command in
`/history`, presses Enter, and asks:

```text
Why did the selected command fail?
```

This story establishes five product facts at once:

1. Pi remains the Agent interface.
2. Termia uses a real interactive terminal and shell.
3. The terminal can traverse SSH and an effective-user switch normally.
4. Termia records command metadata and output against the correct workspace.
5. The Agent can retrieve selected output on demand without copy-paste.

## Message Pillars

### Keep your terminal

Termia runs as a Pi package inside the user's compatible terminal emulator. It
does not provide a terminal window, tabs, panes, renderer, or replacement shell.

### Keep a real shell

The persistent PTY retains the current foreground shell's cwd, environment,
aliases, functions, and jobs while the Pi process is running. Interactive
passwords, confirmations, `/dev/tty`, full-screen programs, native SSH, and
native `sudo` remain terminal interactions rather than chat abstractions.

### Keep the real workspace

For managed SSH, Pi's file tools, resources, and detached Agent Bash follow the
committed Active Workspace. Managed nested hops retain their actual route. After
a supported managed user switch inside managed SSH, the workspace also follows
the effective user. Failures do not silently route Agent operations to another
host or identity.

### Keep history without copy-paste

`/history` shows recorded command metadata and output. The user selects commands,
and Termia inserts compact references containing stable command indexes,
workspace, cwd, exit status, start time, and duration. Pi can then read only the
needed output through an internal tool. The README describes the outcome, not
the internal `termia_history` tool name.

### Keep your model access

Authentication and model selection belong to Pi. Termia works with the supported
subscriptions, API keys, custom providers, and local models the user has already
configured there.

## README Structure

The final README uses this order:

1. Product opening and preview image
2. “How it feels” SSH/history demonstration
3. “Why Termia” message pillars and a compact approach comparison
4. Installation and Pi authentication pointer
5. Quick-start controls
6. History without copy-paste
7. Persistent PTY and detached Agent Bash
8. Managed SSH, nested hops, and managed user switches
9. Active Workspace safety and recovery
10. Requirements and limits
11. Storage, security, uninstall, and license

Detailed recovery mechanics remain available but move below the primary product
story. They should be concise enough not to overwhelm first-time users.

## Public Behavior Contract

The README documents only these public controls:

```text
/termia           enable or disable Termia
/termia reset     confirm and replace the terminal with a fresh local runtime
Ctrl+]            switch between Agent and PTY while the Agent is idle
!command          run in the current foreground shell and add result context
!!command         run in the current foreground shell without result context
/history          browse and select recorded command history
```

The history instructions must state:

- Up/Down moves through commands;
- Space selects multiple commands;
- Pi's tool-output expansion binding (`Ctrl+O` by default) previews output;
- Enter inserts compact references into the editor; and
- Escape closes the overlay.

The README must distinguish the persistent PTY from Agent Bash. Agent Bash is
detached, concurrent, and non-interactive. It follows the Active Workspace but
does not inherit process-local aliases, functions, unexported variables, or jobs,
and its commands are not added to Termia history.

## Accuracy Boundaries

- There is no standalone `termia` executable. `package.json` has no `bin` entry.
- Remove all examples using `termia "..."`, `-n`, `h~N`, `--last`, `--all`,
  `--attach`, `--model`, or `--tools`.
- `/termia-history` and `/termia-mode` do not exist. The public history command
  is `/history`.
- `termia_history` is an internal, mode-gated Agent tool and is not documented as
  a command users should invoke.
- Quick Ask and the old attached/detached prompt flow have been removed.
- Ordinary interactive commands and `!`/`!!` are recorded. Managed topology
  commands such as the `ssh`, `sudo`, or `su` transition itself may be consumed
  as workspace events rather than history entries.
- `!` and `!!` use the same persistent PTY and current foreground shell, which
  may be local, remote, or switched-user. Avoid claiming there is always one
  process across topology transitions.
- PTY process state persists only for the current Pi process. Reattachment
  replays at most the bounded transcript tail; the README must not promise shell
  recovery after a process crash or restart.
- Supported platforms are Linux, WSL2, and macOS. Windows Terminal means Windows
  Terminal hosting WSL2, not native PowerShell or cmd support.
- Managed SSH covers supported plain interactive forms. Remote commands,
  tunnels, and unsupported advanced forms retain native SSH behavior but do not
  become managed workspaces.
- SSH Agent file access requires local SSHFS and remote SFTP. Linux also requires
  `fusermount3`.
- Password-authenticated SSH remains interactive. Termia does not store or replay
  passwords and does not reconnect failed SSH routes automatically.
- Managed `sudo`/`su` identity tracking applies to the documented no-command forms
  inside a managed SSH workspace. Do not claim that a local `sudo -i` becomes a
  Pi Active Workspace.
- Termia does not claim better raw rendering performance than Warp, Wave, or
  Tabby. Its advantage is avoiding another terminal application and interaction
  model.

## Voice

The first half is concise, confident, and user-centered. Prefer concrete verbs:
keep, enter, switch, select, follow, inspect, and recover. Avoid internal class
names except the user-visible terms Active Workspace, Pending Workspace, and
Terminal Reset where they clarify safety behavior.

The second half is precise reference documentation. Limit warnings to boundaries
that affect data safety, host identity, authentication, or recovery.

## Verification

Before committing the rewritten README:

1. Search for every removed CLI flag and obsolete slash command.
2. Check each public command against its registration and tests.
3. Check all SSH and managed-user-switch examples against the supported parsers.
4. Confirm Windows is qualified as WSL2.
5. Run `git diff --check -- README.md`.
6. Run the complete test suite and typecheck.
7. Run `npm pack --dry-run --json` and confirm the rewritten README and preview
   asset are included.
