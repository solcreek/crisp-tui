# crisp-tui verification map

This directory is the maintained source for verifying the user-facing behavior of the crisp-tui demo inbox. Read this index before driving the app, then use the matching feature file as the recipe. Launch, doctor, evidence, and cleanup rules are in `../SKILL.md`.

## Baseline preconditions

- From the crisp-tui checkout, run `bun install` once when `node_modules` is missing.
- Start each recipe with `bun .cursor/skills/verify-crisp-tui/harness.ts launch` unless that recipe says to continue a running demo.
- Export `CRISP_TUI_VERIFY_RUN` to the printed `runId`.
- Run `bun .cursor/skills/verify-crisp-tui/harness.ts doctor` and require the identity in `../SKILL.md`. On a fresh launch, also require `"activeSession":"session_demo_1"` before the first action.
- Drive only the run this verification started.
- Demo rows are in-memory and disappear when that TUI exits. Capture before cleanup.

Demo rows:

- `session_demo_1` is Demo Customer A, unresolved, unread 1, segment billing, last message `Can you help me find my invoice?`.
- `session_demo_2` is Demo Customer B, unresolved, unread 2, segment onboarding, last message `How do I invite my teammates?`.
- `session_demo_3` is Demo Customer C, resolved, segment feedback, last message `That worked. Thank you!`.

## Driving conventions

- Treat every command as literal. Keep quoted text and flags unchanged.
- Send keys only with `bun .cursor/skills/verify-crisp-tui/harness.ts keys`.
- Send agent commands only with `bun .cursor/skills/verify-crisp-tui/harness.ts ctl --`.
- Wait with `bun .cursor/skills/verify-crisp-tui/harness.ts wait`. `pty` matches the current screen replayed from the log. `screen`, `status`, and `messages` read `ctl`.
- Require the exit code and the observable text named in the recipe. A skipped entry point is not verified by a different path.
- `ctl.jsonl` and `keys.jsonl` in the evidence directory record the actions. `capture` records the state after them.
- Do not remove proof artifacts during cleanup.

## Proof and skip reporting

- Capture the command and the resulting state, not only the final screen.
- UI proof is a `wait pty` match plus `screen.txt` from capture.
- Inbox side effects are `messages.json` or `conversations.json` from a capture taken after the action.
- Record the feature file and the entry point in the capture `--action` text.
- Report an unreachable path with the command that was run and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with verify-crisp-tui` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

## Features

- [Open a conversation](./open-conversation.md) covers startup, keyboard open, agent goto, and inbox paging.
- [Search conversations](./search.md) covers inbox and messages search, a match, an empty page, and clearing the query.
- [Reply and internal note](./reply-and-note.md) covers keyboard reply, Tab into the composer, and Ctrl+N notes.
- [Agent draft](./agent-draft.md) covers an unsent draft, overwrite refusal, Enter to send, a note draft, and replace without sending.
- [Resolve and mark read](./resolve-and-read.md) covers resolve, reopen, and mark read on the open conversation.
