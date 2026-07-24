# README Cleanup Design

## Goal

Make the package README a concise user guide for GitHub and npm that documents
only Termia's current public behavior.

## Structure

1. Open with the product description and the existing Termia history preview.
2. Keep installation, dependency, and source-install instructions near the top.
3. Present only the public controls: `/termia`, `Ctrl+]`, `!`, `!!`, and
   `/history`.
4. Explain persistent-shell behavior, non-interactive Agent Bash, and managed
   nested SSH workspaces in user-facing language.
5. Finish with storage, limits, uninstall, security, and license information.

## Cleanup Boundary

- Remove obsolete shell `termia`, quick-ask, `/termia-history`, and
  `/termia-mode` wording.
- Remove internal names and implementation details such as `termia_history`,
  `getAgentDir()`, hooks, protocol behavior, and integration fixtures.
- Remove repeated explanations while preserving password/input limitations,
  manual SSH reconnection, and the distinction between interactive commands
  and Agent Bash.
- Reference the existing preview through its stable GitHub Raw URL so it renders
  on both GitHub and npm.

## Verification

- Search the README for removed and internal terminology.
- Check every documented command against the registered extension commands.
- Run Markdown whitespace checks and `npm pack --dry-run --json` to confirm the
  README and preview asset remain in the published package.
