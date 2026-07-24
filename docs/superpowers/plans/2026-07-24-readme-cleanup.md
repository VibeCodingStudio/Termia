# README Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the implementation-heavy README with a concise GitHub/npm user guide that shows the existing preview image and documents only current public behavior.

**Architecture:** `README.md` remains the single public guide. Reorder it around installation and common use, remove internal API/protocol/test details, and reuse the stable preview URL already declared in package metadata.

**Tech Stack:** GitHub-flavored Markdown, npm package metadata

## Global Constraints

- Modify only `README.md`; preserve the user's existing `package.json` change.
- Public controls are `/termia`, `Ctrl+]`, `!`, `!!`, and `/history`.
- Do not document shell `termia`, quick asks, `/termia-history`, `/termia-mode`, or the internal `termia_history` tool.
- Keep password/input limitations, manual SSH reconnection, nested SSH, storage, uninstall, security, and license guidance.
- Render `assets/termia-preview.png` on both GitHub and npm through `https://raw.githubusercontent.com/VibeCodingStudio/Termia/main/assets/termia-preview.png`.

---

### Task 1: Rewrite and verify the public README

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: current extension commands in `extensions/termia/index.ts` and `extensions/termia/history-overlay.ts`
- Produces: the GitHub/npm package guide included by the existing `package.json#files` allowlist

- [ ] **Step 1: Replace the README organization**

Use these sections in order, with no additional implementation-reference section:

```markdown
# Termia

Termia gives Pi a persistent interactive shell, recorded command history, and
managed nested SSH workspaces. It stays disabled until you run `/termia`, so Pi
keeps its normal coding-agent behavior by default.

![Termia command history in a managed SSH workspace](https://raw.githubusercontent.com/VibeCodingStudio/Termia/main/assets/termia-preview.png)

## Install
## Quick start
## Persistent shell and Agent commands
## Command history
## Managed SSH workspaces
## Storage
## Limits
## Uninstall
## Security
## License
```

The quick-start control table must contain exactly:

```text
/termia           enable or disable Termia
Ctrl+]            switch between Agent and terminal while the Agent is idle
!command          run in the persistent shell and add the result to Agent context
!!command         run in the persistent shell without adding it to Agent context
/history          open recorded command history
```

Describe Agent Bash as detached, concurrent, non-interactive, and outside Termia history. Direct users to the persistent terminal for passwords, confirmations, aliases, functions, unexported variables, and job state.

- [ ] **Step 2: Verify removed terminology and public commands**

Run:

```bash
rg -n -i 'quick[- ]?ask|/termia-history|/termia-mode|termia_history|getAgentDir|ControlMaster|integration fixture|protocol' README.md
rg -n '/termia|Ctrl\+\]|!command|!!command|/history' README.md
git diff --check -- README.md
```

Expected: the first command has no matches; the second finds all five public controls; `git diff --check` exits 0.

- [ ] **Step 3: Verify the publishable README and image**

Run:

```bash
npm pack --dry-run --json
```

Expected: exit 0, with both `README.md` and `assets/termia-preview.png` in the `files` array.

- [ ] **Step 4: Commit only the README**

```bash
git add README.md
git commit -m "docs: streamline package README"
```
