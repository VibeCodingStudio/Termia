# PTY History Replay Design

## Status

Approved in conversation on 2026-07-26. This document is awaiting the written
spec review gate before implementation planning.

## Goal

When a user switches from the Agent back into the persistent PTY, show the
PTY's recent input and output again instead of presenting a cleared terminal.

The replay must be display-only. It must not execute input again, append
duplicate transcript data, change command-history boundaries, or alter the
existing `Ctrl+]` detach behavior.

## Cause

Termia already records all parsed PTY output in the active terminal transcript.
The data is not deleted when the user presses `Ctrl+]`.

The visible history disappears because returning to Pi forces a full TUI
redraw that clears the terminal emulator's scrollback. Entering the PTY then
clears the viewport and sends `Ctrl+L` to the shell, but the persistent PTY
does not redraw output that was already produced. The PTY therefore remains
stateful while its previous input and output are no longer visible.

## Scope

This change will:

- replay recent output from the active transcript whenever the PTY is attached;
- stop sending `Ctrl+L` to the persistent shell during attachment;
- preserve live PTY input, output, resize, detach, and process behavior;
- preserve Pi's existing TUI redraw behavior.

This change will not:

- preserve terminal-emulator scrollback while the Agent UI is visible;
- reconstruct an exact virtual screen, cursor position, or alternate screen;
- change Pi TUI internals or add a terminal-emulator dependency;
- change transcript persistence, command extraction, or `/history` behavior.

## Architecture

`HistoryStore` remains the transcript owner and gains one read-only operation
for the active terminal's recent output. `TerminalController` remains the PTY
attachment owner and uses that operation only while entering terminal mode.

```text
active transcript -- read bounded tail --> TerminalController.enter()
                                             |
                                             +-- write replay to stdout
                                             +-- attach stdin to live PTY
```

The interface returns text rather than exposing transcript paths or file
handles. This keeps filesystem layout and byte-boundary handling inside
`HistoryStore`.

## Transcript Tail Contract

The active transcript tail reader will:

- accept a positive byte limit;
- return the whole transcript when it is within that limit;
- otherwise return at most the configured tail window, preferring the first
  complete line after the truncation boundary;
- fall back to a safely decoded bounded suffix when one output line itself is
  longer than the limit;
- avoid changing the active output offset or any command record.

PTY attachment will request at most 1 MiB. The transcript on disk remains
complete; the limit applies only to one screen replay so very long sessions do
not make attachment increasingly slow or memory-heavy.

## Attachment Flow

On each PTY attachment, `TerminalController` will:

1. stop the Pi TUI and drain pending TUI input as it does today;
2. clear only the current viewport and reset terminal text attributes;
3. read and write the active transcript tail directly to stdout;
4. enable raw input, resize the PTY, and attach input and signal handlers;
5. leave the shell untouched instead of sending `Ctrl+L`.

New PTY output continues through the existing output boundary: it is appended
once to the transcript and written live to stdout only while attached. Replayed
bytes bypass that boundary, so they cannot be recorded a second time or sent
back as shell input.

If the transcript tail cannot be read, attachment will remain usable: Termia
will show a concise replay warning and continue attaching to the live PTY.
Existing setup failures after input state changes will continue through the
current cleanup path, which restores the Pi TUI and raw-mode state.

## Validation

Focused tests will prove that:

- the transcript reader returns complete small transcripts;
- a large transcript replay is bounded and starts cleanly when possible;
- reading a tail does not change the active output offset;
- entering the PTY displays existing transcript output;
- entering the PTY no longer writes `Ctrl+L` to the PTY;
- replayed output is not appended to history;
- `Ctrl+]` still detaches and resumes the Pi TUI;
- a replay-read failure does not prevent live PTY attachment.

The implementation will then run the complete test suite and typecheck in
addition to the focused regression tests.
