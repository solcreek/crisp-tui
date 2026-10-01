# Resolve and mark read

Ctrl+E resolves or reopens the conversation that is open, not the row that is only highlighted. Ctrl+U marks that same open conversation read and clears its unread count.

## Sub-features

- `resolve-open-not-highlight` resolves Demo Customer A while the highlight is on Demo Customer B.
- `reopen` returns that conversation to unresolved.
- `mark-read` sets Demo Customer A's operator unread count to 0 and leaves Demo Customer B unread.

## How to get to it (user POV)

- Open a conversation, or use the one startup already opened.
- Press Ctrl+E to resolve it. Press Ctrl+E again to reopen it.
- Press Ctrl+U to mark it read.
- Highlighting another inbox row does not change which conversation these keys affect.

## Driving it with verify-crisp-tui

Preconditions:

- Fresh launch, with doctor `"ok":true` and `"activeSession":"session_demo_1"`.
- The inbox pane is focused.

- **Highlight a different row.** Press `j`. Run `bun .cursor/skills/verify-crisp-tui/harness.ts keys j`. Exit 0. `ctl state` still has `active.session_id` `session_demo_1`.
- **Resolve the open conversation.** Press Ctrl+E. Run `bun .cursor/skills/verify-crisp-tui/harness.ts keys ctrl-e`, `bun .cursor/skills/verify-crisp-tui/harness.ts wait status -- 'Conversation resolved'`, and `bun .cursor/skills/verify-crisp-tui/harness.ts wait screen -- 'Demo Customer A [resolved] session_demo_1'`. The screen text still contains `Demo Customer B [unresolved] session_demo_2`.
- **Reopen it.** Press Ctrl+E again. Run `bun .cursor/skills/verify-crisp-tui/harness.ts keys ctrl-e`, `bun .cursor/skills/verify-crisp-tui/harness.ts wait status -- 'Conversation reopened'`, and `bun .cursor/skills/verify-crisp-tui/harness.ts wait screen -- '> Demo Customer A [unresolved] session_demo_1'`.
- **Mark it read.** Press Ctrl+U. Run `bun .cursor/skills/verify-crisp-tui/harness.ts keys ctrl-u` and `bun .cursor/skills/verify-crisp-tui/harness.ts wait status -- 'Marked read'`. `ctl conversations` gives Demo Customer A `unread.operator` 0 and Demo Customer B `unread.operator` 2.
- **Proof.** Run `bun .cursor/skills/verify-crisp-tui/harness.ts capture resolve-and-read --action "ctrl-e resolve, ctrl-e reopen, ctrl-u mark read"`. `resolve-and-read/screen.txt` contains `> Demo Customer A [unresolved] session_demo_1` and `Marked read`. `resolve-and-read/conversations.json` shows operator unread 0 for `session_demo_1` and 2 for `session_demo_2`.

## Gotchas

- Ctrl+E and Ctrl+U ignore the highlight. `j` without Enter leaves Demo Customer A as the open conversation.
- Opening a conversation does not mark it read. That check is in `open-conversation.md`.
- The PTY log still contains the unread badge from earlier frames. Prove the current count with `ctl conversations`.
- These keys are refused by a read-only TUI. Doctor requires `"readOnly":false` before this recipe.
