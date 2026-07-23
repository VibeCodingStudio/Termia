# Stable SSH Mount Takeover Design

## Goal

Reuse Termia's stable `/tmp/termia-ssh/<depth>-<user>@<host>` workspace path even when a previous process left that path behind.

## Behavior

Before mounting SSHFS, Termia takes over the stable path:

1. Best-effort unmount any old SSHFS mount at that exact path.
2. Verify the path is no longer a mount point.
3. Remove the stale directory and recreate it with mode `0700`.
4. Continue through the existing bridge, probe, and SSHFS startup flow.

An older Termia process using the same path loses its SSHFS workspace. If the path remains mounted after the unmount attempt, Termia fails without recursively deleting it, preventing remote-file deletion.

## Scope

Keep the existing stable naming, SSH control connections, history, and nested-hop behavior unchanged. Add one focused regression test for replacing a stale workspace path; do not add locks, ownership registries, or reconnection behavior.
