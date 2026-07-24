# Session History Command and Idle Shortcut Design

## Goal

Make Termia's history command feel native inside Termia mode and ensure
`Ctrl+]` never schedules a delayed PTY switch while the Agent is running.

## `/history` lifecycle

- A normal Pi session registers `/termia` but not `/history`.
- Entering Termia switches to its managed Pi session. That session registers
  `/history` with the description `Show persistent-shell command history`.
- Leaving Termia returns to the original Pi session, where `/history` is absent.
- `/termia-history` is removed rather than retained as an alias.
- User-facing documentation and truncated-output hints refer to `/history`.
- Pi currently has no built-in `/history`. If another extension registers the
  same name, Pi's existing command-conflict suffixing remains authoritative.

Termia already replaces and rebinds the Pi runtime on every managed-session
transition. Command availability will follow that session lifecycle rather
than introducing input interception or a private command registry.

## `Ctrl+]` while the Agent runs

The Termia editor handles the shortcut according to active-session state:

- Termia disabled: forward the key to the underlying Pi editor.
- Termia enabled and Agent busy: consume the key silently and submit nothing.
- Termia enabled and Agent idle: preserve the draft and enter the PTY as today.

The editor receives the public `ctx.isIdle()` state from the current
`session_start` context. A consumed busy-state key is not queued, replayed,
converted into `/termia __terminal`, or accompanied by a notification.

## Entry hint

The first successful Termia entry reports:

```text
Termia enabled · /history opens command history · Ctrl+] switches between Agent and PTY
```

Later entries report:

```text
Termia enabled · /history opens command history
```

## Validation

- Unit-test that `/history` is registered only by a Termia-enabled extension
  runtime and `/termia-history` is absent.
- Unit-test that busy `Ctrl+]` is consumed without submission and is not
  replayed when the Agent later becomes idle.
- Preserve the existing idle shortcut, disabled-mode forwarding, draft
  restoration, history overlay, session transition, and SSH behavior tests.
- Run the full test suite, typecheck, npm dry-run pack, and diff check.
