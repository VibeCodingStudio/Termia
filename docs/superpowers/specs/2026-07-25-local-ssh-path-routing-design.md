# Local and SSH Path Routing Design

## Goal

Keep Pi's normal access to local absolute paths while routing relative and
explicit `ssh://` paths to the active Termia SSH workspace. Local Pi skills
must load without being projected into SSHFS.

## Path Contract

While an SSH workspace is active:

| Input | Target |
|---|---|
| `src/index.ts` | The active remote cwd |
| `/home/klein/file` | The local machine |
| `ssh://root@host/etc/hosts` | `/etc/hosts` on the active SSH leaf |

Without an active SSH workspace, relative and absolute filesystem paths keep
Pi's normal local behavior. An `ssh://` path is rejected because there is no
active SSH target.

The authority of an `ssh://` path must match the current leaf's user, host, and
port. Termia does not route directly to retained parent hops. The user must
exit to a parent before it becomes the active SSH workspace.

`~` paths remain rejected in SSH mode because Termia cannot resolve the remote
home safely. Callers use a relative remote path, an `ssh://` absolute path, or
a local absolute path instead.

## Prompt Presentation

- Continue presenting the active cwd as `ssh://user@host/path`.
- Add concise path guidance: relative file paths use the active remote cwd,
  local absolute paths stay local, and remote absolute paths use `ssh://`.
- Inspect `before_agent_start.systemPromptOptions.skills` instead of scanning
  package directories.
- Keep local skill locations as their original absolute paths.
- Convert skill locations already under the current SSHFS mount from their
  internal physical path to the matching logical `ssh://` URI.
- Never expose `/tmp/termia-ssh/...` as a logical workspace path.

Local Pi documentation and other absolute host resources therefore continue to
work without special directory allowlists.

## Tool Routing

Apply the path contract consistently to `read`, `edit`, `write`, `grep`,
`find`, and `ls`:

1. A local absolute path is passed through unchanged and does not depend on SSH
   health.
2. An `ssh://` path is parsed, its authority is validated against the current
   leaf, and its URI path is projected under the current mount root.
3. A relative path is resolved from the active remote cwd and projected under
   the current mount root.
4. Remote path normalization remains confined to the mounted remote root.
5. A disconnected SSH workspace blocks relative and `ssh://` paths but not
   local absolute paths.

`bash` keeps its existing active-workspace behavior. It runs locally outside
SSH and on the active remote host inside SSH. Loading a local skill does not
make its bundled helper scripts execute locally or copy them to the remote
host.

## `@file`

Termia does not define an `@file` path namespace. Pi accepts `@file` only as a
CLI startup argument, removes the `@`, and reads the file before Termia handles
workspace tools. Remove Termia's unused leading-`@` path handling and its
synthetic tests.

## Errors

- Reject malformed `ssh://` URIs.
- Reject an authority that differs from the active SSH leaf and report both the
  requested and active authorities.
- Reject `ssh://` when no SSH workspace is active.
- Preserve the existing disconnected-workspace error for remote routes.
- Preserve operating-system permission and missing-file errors for local
  absolute paths.

## Validation

- Local absolute skill paths remain unchanged in an SSH workspace.
- Arbitrary local absolute paths work with every file tool while SSH is active.
- Relative paths resolve under the active remote cwd.
- Matching `ssh://` paths resolve under the active SSHFS mount.
- Malformed, mismatched, disconnected, and path-traversal cases fail safely.
- Remote project skill locations appear as logical `ssh://` paths.
- Existing physical mount paths are not double-prefixed.
- The full typecheck and test suite pass.

## Scope

Change only workspace path routing, system-prompt presentation, and their
tests. Do not change PTY behavior, SSH connection management, mount lifecycle,
session handoff, history, TUI behavior, or npm publishing.
