# Termia

Termia manages a persistent terminal and the workspaces it exposes to Pi. This
glossary names the user-visible concepts that stay consistent across local,
SSH, and switched-user use.

## Language

**Active Workspace**:
The single environment in which Agent actions take effect while Termia mode is
enabled. It follows the foreground managed shell and consists of its effective
host, identity, working directory, route, and availability; the Pi session
follows it but is not part of it.
_Avoid_: Workspace binding, current directory, Pi session

**Pending Workspace**:
A terminal environment that has been entered but has not become the Active
Workspace. Agent actions remain in the previous Active Workspace until the
pending environment is either committed or exited.
_Avoid_: Active Workspace, temporary mount

**Terminal Reset**:
An explicit recovery action that discards the persistent terminal and its
managed workspace chain, then returns Termia to a fresh local workspace. It is
never automatic and loses the terminal's shell state and jobs.
_Avoid_: Reconnect, retry
