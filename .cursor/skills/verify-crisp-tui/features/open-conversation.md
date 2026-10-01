# Open a conversation

Opening a conversation shows that customer's messages and leaves their unread count unchanged. The inbox can also move to the next demo page, which is empty, and come back.

## Sub-features

- `inbox-startup` shows three demo rows and opens Demo Customer A.
- `inbox-keyboard-open` moves the highlight with `j` and `k`, then opens the highlighted row with Enter.
- `inbox-agent-goto` opens a session from `ctl goto` without marking it read.
- `inbox-page` moves to the empty second page and back.
- `inbox-refresh` keeps the same three demo rows after Ctrl+R.

## How to get to it (user POV)

- Start the demo inbox. The first row is already open.
- Press `j` or `k` in the inbox, then Enter, to open the highlighted row.
- Click an inbox row. The helper cannot click, so keyboard Enter is the driven form of that path.
- Run `ctl goto SESSION` against the running demo.
- Press `]` for the next page and `[` for the previous page, from the inbox or messages pane.
- Press Ctrl+R from any pane to refresh.

## Driving it with verify-crisp-tui

Preconditions:

- Fresh launch, with doctor `"ok":true` and `"activeSession":"session_demo_1"`.

- **Startup row.** Read the loaded inbox. Run `bun .cursor/skills/verify-crisp-tui/harness.ts ctl -- screen` and `bun .cursor/skills/verify-crisp-tui/harness.ts ctl -- conversations`. Exit 0. The screen text contains `> Demo Customer A [unresolved] session_demo_1`, `Demo Customer B [unresolved] session_demo_2`, and `Demo Customer C [resolved] session_demo_3`. Conversations JSON gives Demo Customer A `unread.operator` 1 and Demo Customer B `unread.operator` 2.
- **Highlight returns to the open row.** Press `j`, then `k`, then Enter, and type one character. Run `bun .cursor/skills/verify-crisp-tui/harness.ts keys j`, `bun .cursor/skills/verify-crisp-tui/harness.ts keys k`, `bun .cursor/skills/verify-crisp-tui/harness.ts keys enter`, `bun .cursor/skills/verify-crisp-tui/harness.ts keys type -- x`, and `bun .cursor/skills/verify-crisp-tui/harness.ts wait screen -- 'Reply draft: x'`. Exit 0. `ctl state` has `active.session_id` `session_demo_1` and `draft.text` `x`. `ctl conversations` still gives Demo Customer A `unread.operator` 1. Press backspace. Run `bun .cursor/skills/verify-crisp-tui/harness.ts keys backspace`. `ctl state` then has `draft.text` `""`.
- **Open the next row.** Return to the inbox, move down, and press Enter. Run `bun .cursor/skills/verify-crisp-tui/harness.ts keys esc`, `bun .cursor/skills/verify-crisp-tui/harness.ts keys j`, and `bun .cursor/skills/verify-crisp-tui/harness.ts keys enter`. Then run `bun .cursor/skills/verify-crisp-tui/harness.ts wait status -- 'Opened Demo Customer B'` and `bun .cursor/skills/verify-crisp-tui/harness.ts wait screen -- '> Demo Customer B [unresolved] session_demo_2'`. Both exit 0. Conversations JSON still gives Demo Customer B `unread.operator` 2.
- **Agent goto.** Open Demo Customer C. Run `bun .cursor/skills/verify-crisp-tui/harness.ts ctl -- goto session_demo_3`. Exit 0. Then run `bun .cursor/skills/verify-crisp-tui/harness.ts wait status -- 'Agent opened a conversation'` and `bun .cursor/skills/verify-crisp-tui/harness.ts wait screen -- '> Demo Customer C [resolved] session_demo_3'`. Both exit 0.
- **Next page.** Focus the inbox and press `]`. Run `bun .cursor/skills/verify-crisp-tui/harness.ts keys esc` and `bun .cursor/skills/verify-crisp-tui/harness.ts keys next`. Then run `bun .cursor/skills/verify-crisp-tui/harness.ts wait screen -- 'Inbox · page 2 · all'` and `bun .cursor/skills/verify-crisp-tui/harness.ts wait pty -- 'No conversations on this page.'`. `ctl conversations` is `[]`. The screen text still contains `Conversation: Demo Customer C (session_demo_3)`.
- **Previous page.** Press `[`. Run `bun .cursor/skills/verify-crisp-tui/harness.ts keys prev` and `bun .cursor/skills/verify-crisp-tui/harness.ts wait screen -- 'Inbox · page 1 · all'`. The screen text lists all three demo session ids.
- **Refresh.** Press Ctrl+R. Run `bun .cursor/skills/verify-crisp-tui/harness.ts keys ctrl-r` and `bun .cursor/skills/verify-crisp-tui/harness.ts ctl -- state`. Exit 0. `source` is `DEMO · local only` and `conversations` has length 3.
- **Proof.** Run `bun .cursor/skills/verify-crisp-tui/harness.ts capture open-conversation --action "keyboard open, ctl goto, page, refresh"`. `open-conversation/screen.txt` contains `Inbox · page 1 · all` and `session_demo_2`. `open-conversation/conversations.json` still shows Demo Customer B `unread.operator` 2.

## Gotchas

- Enter in the composer sends a draft. After Enter opens a row, press `esc` before `j`, `k`, `[`, or `]`.
- `j` without Enter does not change the open conversation. Ctrl+E and Ctrl+U still act on the open row.
- `ctl goto` does not focus the composer. A following `keys type` is not a composer edit unless the composer was already focused.
- Page 2 of the demo has no rows. The previously open conversation stays open in the message pane.
- The PTY log still contains `No conversations on this page.` after returning to page 1. Prove the current page with `ctl screen`.
