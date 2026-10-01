---
name: verify-crisp-tui
description: "Drive the crisp-tui demo inbox in an isolated PTY and prove inbox, search, reply, agent draft, and resolve behavior. Use when changing the TUI, composer, keyboard handling, or ctl socket, before claiming a user-visible fix."
---

# Verify crisp-tui

Drive the demo inbox the way a person and an agent do. People use the terminal. Agents use `ctl` against that same running screen. The feature map is `features/README.md`. Read it before choosing a path. A proof that drives one entry point is incomplete when the map lists another.

Verification starts only `src/index.ts --demo --poll 0` from this checkout, on a private socket. It does not start `live`, `check`, or `cli`. Those paths can read 1Password or send Crisp traffic. Demo mode is in-memory and is the supported no-credential inbox. Doctor still has to read `source` and `realtime` from the running TUI; the flag alone is not the proof.

Run the helper from the crisp-tui checkout:

```sh
bun .cursor/skills/verify-crisp-tui/harness.ts <command>
```

The helper finds the checkout from its own path. `ctl` subprocesses use that checkout, not the caller's current directory. If `node_modules` is missing, run `bun install` in the checkout once, then launch again.

## Launch

One command starts a supervisor and the demo TUI:

```sh
bun .cursor/skills/verify-crisp-tui/harness.ts launch
```

Pass `--run <id>` or set `CRISP_TUI_VERIFY_RUN` to choose the id. Otherwise launch generates one. An id matches `^[a-z0-9][a-z0-9-]{0,39}$`. Launch claims `/tmp/crisp-tui-verify/<id>` with an exclusive create and refuses the id when that directory already exists. The refused launch does not stop the run that owns the directory. Launch also refuses an id whose evidence directory already has files, because cleanup leaves that directory in place and a second launch must not append to it.

Stdout is one JSON object. Require `"ok":true`, `"source":"DEMO · local only"`, and `"activeSession":"session_demo_1"`. Export the printed `runId`:

```sh
export CRISP_TUI_VERIFY_RUN=<runId>
```

Every later command reads `CRISP_TUI_VERIFY_RUN`, or an explicit `--run <id>`.

The supervisor owns a 100×30 PTY. The TUI's `CRISP_TUI_SOCKET` is `/tmp/crisp-tui-verify/<runId>/control.sock`. The parent directory is mode 0700. The harness deletes `CRISPCTL_READ_ONLY` from the TUI environment so a shell setting cannot turn this instance into read-only. Ready means doctor passes, which includes an open conversation. A failed launch runs cleanup itself.

The default socket `/tmp/crisp-tui-<uid>/<profile-hash>.sock` is shared by demo and live for one profile. This helper never uses it. Two verification runs can run side by side when their run ids differ. Do not drive a TUI this run did not start.

There is no long-lived server beyond that supervisor and its TUI. Teardown is the cleanup command below.

## Doctor

Run this first whenever the screen, the socket, or a `ctl` result looks wrong:

```sh
bun .cursor/skills/verify-crisp-tui/harness.ts doctor
```

Stdout is one JSON object. Exit 0 only when `"ok":true`. Require all of these:

- `source` is `DEMO · local only`
- `protocol` is `2`
- `readOnly` is false
- `realtime` is `off`
- `socket` is `/tmp/crisp-tui-verify/<runId>/control.sock`
- `activeSession` is a non-empty string
- `packageVersion` is the checkout's `package.json` version

Doctor is read-only. It checks the recorded supervisor and TUI pids, that their command lines and start times still match the processes this run spawned, that the TUI command is this checkout's `src/index.ts --demo --poll 0`, that the TUI environment points at this run's socket and does not contain `CRISPCTL_READ_ONLY=1`, and that `ctl state` returns the demo snapshot above. `"conversationLoading":true` or a missing conversation means not ready yet; run doctor again. Any other `"ok":false` means stop. Do not send keys to that process.

## Drive

Human keys go through `keys`. Agent commands go through `ctl`. Do not write the PTY yourself, do not open the default socket, and do not call `src/index.ts` except through this helper. Before `ctl`, `keys`, `wait`, or `capture`, the helper runs the same identity check as doctor. A process that is not this checkout's demo on the private socket is not driven.

```sh
bun .cursor/skills/verify-crisp-tui/harness.ts keys <name> [--repeat N]
bun .cursor/skills/verify-crisp-tui/harness.ts keys type -- <text>
bun .cursor/skills/verify-crisp-tui/harness.ts ctl -- <ctl arguments>
bun .cursor/skills/verify-crisp-tui/harness.ts wait pty|screen|status|messages -- <text>
```

Send one `keys` command at a time and wait for its JSON `{"ok":true}` before the next. `keys type` sends printable ASCII only, including spaces. Control keys have their own names:

- `enter` submits the focused control. In the inbox it opens the highlighted row and focuses the composer. In the composer it sends the draft. In search it submits the query.
- `tab` cycles inbox, then messages, then composer, then inbox. The helper has no Shift+Tab key.
- `esc` focuses the inbox. The helper waits 50 ms after sending it before it returns, so the next key is not parsed as Alt. Send it alone.
- `j` and `k` move the inbox highlight down and up. `up` and `down` are the arrow keys.
- `slash` opens search from the inbox or the messages pane.
- `prev` and `next` are the `[` and `]` page keys.
- `backspace` deletes one search or composer character. `--repeat N` repeats a named key, from 1 to 50.
- `ctrl-n` toggles reply and internal note for the open conversation.
- `ctrl-e` resolves or reopens the open conversation.
- `ctrl-u` marks the open conversation read.
- `ctrl-r` refreshes the inbox and the open conversation.
- `ctrl-j` inserts a newline in the composer.

`ctl` arguments after `--` are passed to this checkout's `ctl`. Its stdout, stderr, and exit code are the TUI's, unchanged. Exit 0 is success, 1 is an operation error, 2 is usage, 3 means no TUI is listening. Do not add `--demo`, `--read-only`, or `--poll` to `ctl`; those are TUI options and exit 2.

Verbs that exist: `state`, `screen`, `conversations`, `messages`, `refresh`, `goto SESSION`, `draft SESSION TEXT`, plus `--note` and `--replace` on `draft`. `state`, `screen`, `conversations`, and `messages` are snapshots of the loaded screen. `screen` is the semantic text view, not a pixel copy of the PTY. There is no `ctl` verb for send, search, resolve, or mark read. Those happen only through the keys above. `draft` focuses the composer and does not send.

`wait` polls for 5 seconds. A `ctl` read that does not answer is killed when that deadline passes. `pty` replays the log onto the 100×30 screen and matches the text visible there. A cell update that leaves part of a phrase in place still matches the whole phrase. `screen`, `status`, and `messages` read `ctl screen`, `state.status`, and `ctl messages`. Exit 0 is `{"ok":true,"via":...}`. Exit 1 means the text did not appear; the stderr JSON includes the reason and, for `pty`, the replayed screen.

The saved `pty.log` is the raw byte log and keeps old frames. `wait pty` searches the screen those bytes currently show, not the raw log. Current inbox, draft, and message state come from `ctl`.

The three demo rows, their session ids, unread counts, and last messages are listed once in `features/README.md`. Startup opens `session_demo_1` and leaves the inbox pane focused. The composer is focused by Enter on an inbox row, by the second `tab` from the inbox, or by `ctl draft`.

## Evidence

Proof directory: `.cursor/skills/verify-crisp-tui/evidence/<runId>/`. Launch creates it. Cleanup leaves it in place.

Every public `ctl` invocation is appended to `ctl.jsonl`. Every successful `keys` invocation is appended to `keys.jsonl`. Each line has the timestamp, the arguments, and for `ctl` the exit code, stdout, and stderr. That log is the action record.

```sh
bun .cursor/skills/verify-crisp-tui/harness.ts capture <name> --action "<what the user just did>"
```

`<name>` matches `^[a-z0-9][a-z0-9-]{0,40}$`. The capture directory contains `action.txt`, `state.json`, `screen.txt`, `messages.json`, `conversations.json`, `pty.log`, and `manifest.json`. Capture after the action, once `wait` has matched, so the snapshot is the resulting state rather than a frame from before the key landed.

A proof needs both sides. The jsonl line is the key or `ctl` command that was sent. The capture is the state after it. `ctl screen` plus a PTY `wait` shows what was visible. `ctl messages` or `ctl conversations` shows the inbox side effect. Demo sends do not write a database or a Crisp request; the message list inside the running demo is the side effect, and a later `ctl messages` is the second view of it. `realtime` staying `off` and `source` staying `DEMO · local only` are the observation that this run did not open a Crisp RTM session. Do not substitute a unit test, a store method call, or `cli reply` for these paths.

## Cleanup

```sh
bun .cursor/skills/verify-crisp-tui/harness.ts cleanup
```

Cleanup writes Ctrl+C to the PTY this run owns, waits for that TUI to exit, then signals only the recorded supervisor and TUI pids when their command lines and start times still match. It does not signal by process name. It removes `/tmp/crisp-tui-verify/<runId>` and does not remove `.cursor/skills/verify-crisp-tui/evidence/<runId>`. Stdout reports `evidenceDir` and `evidenceExists`. After a failed drive, run cleanup so the run directory is gone before the next launch.

Confirm a cited capture file is still on disk after cleanup returns. A cleanup that deletes that file is wrong.

## Helpers

The only helper is `harness.ts`, invoked as `bun .cursor/skills/verify-crisp-tui/harness.ts`. `help` prints the command list. The contract for arguments, exit codes, and proof files is the sections above, not the help text.

| Command | Role |
| --- | --- |
| `launch` | Start the isolated demo PTY. Stdout JSON. Exit 0 when doctor would pass. |
| `doctor` | Read-only identity check. Stdout JSON. Exit 0 only when `ok` is true. |
| `ctl -- …` | Real `ctl` against this run. TUI stdout, stderr, and exit code. Recorded in `ctl.jsonl`. |
| `keys …` | One key or a printable ASCII string. Stdout `{"ok":true}`. Recorded in `keys.jsonl`. |
| `wait <kind> -- <text>` | Poll up to 5 seconds. Exit 0 when the text is present. |
| `capture <name> --action "…"` | Write the post-action snapshot under the evidence directory. |
| `cleanup` | Stop this run's processes and keep the evidence directory. |
