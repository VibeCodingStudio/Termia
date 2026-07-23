# Termia 0.1.1 Reliability Design

## Goal

Fix BusyBox `ash` Agent commands that hang past their timeout, and make SSH workspace paths stable so managed Pi sessions can be reused after reconnecting to the same host.

## Chosen design

Long explicit-exec payloads enter one `__termia_exec_stream` reader and then arrive as short Base64 lines before `__termia_exec` is invoked. This avoids BusyBox's interactive input-length ceiling without adding a remote dependency, and the payload chunks never become shell-history commands.

An aborted execution sends `Ctrl+C` whenever input has already been written, even if the shell has not emitted its `start` token. This releases continuation prompts and other pre-start stalls; the existing protocol still owns final completion.

An Agent bash command may remain active while the user attaches to its PTY to answer an interactive prompt such as `sudo` or SSH password input. Terminal attachment is single-flight: a repeated `Ctrl+]` cannot install another stdin listener or restart the Pi TUI twice. Detaching returns input ownership to the Agent UI without recording or interpreting the entered secret.

SSHFS mounts use `/tmp/termia-ssh/<hop>-<user@host>` as their visible root. Random runtime directories remain only for bridge scripts. Mount-directory creation is exclusive, so a second live Termia process cannot steal the same stable mountpoint.

## Alternatives rejected

- Only send `Ctrl+C`: bounds the hang but leaves every long ash command unusable.
- Increase PTY width or BusyBox limits: depends on the remote BusyBox build and is not portable.
- Reuse an existing SSHFS mount automatically: introduces cross-process ownership and credential-lifetime coupling that is unnecessary for session cwd reuse.

## Validation

- A long explicit-exec command is emitted as bounded lines and reconstructs exactly.
- A timeout interrupts an execution after input is written but before a start token exists.
- An active Agent command accepts interactive PTY input, while concurrent attach attempts leave exactly one stdin listener and one TUI lifecycle.
- SSH mount paths are deterministic and preserve nested-hop naming.
- Existing ash, bash, zsh, SSH, history, typecheck, package, and isolated Pi-install checks remain green.
- Publish exactly `@vibecodingstudio/termia@0.1.1` after the repository commit is pushed.
