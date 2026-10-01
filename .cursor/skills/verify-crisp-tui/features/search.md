# Search conversations

Search filters the demo inbox by nickname, email, segment, last message, session id, state, or unread count. An empty query shows all three rows again. A query with no match shows an empty page and does not close the conversation that was already open.

## Sub-features

- `search-inbox` opens search with `/` from the inbox.
- `search-messages` opens search with `/` from the messages pane.
- `search-match` keeps the matching row and drops the others.
- `search-empty` shows the empty-page line for a query that matches nothing.
- `search-clear` backspaces the prefilled query and submits an empty search.

## How to get to it (user POV)

- Press `/` while the inbox pane is focused, type, and press Enter.
- Press `/` while the messages pane is focused, type, and press Enter.
- Submit an empty field to return to the full inbox.
- `/` in the composer is not search. It types a slash into the draft.

## Driving it with verify-crisp-tui

Preconditions:

- Fresh launch, with doctor `"ok":true` and `"activeSession":"session_demo_1"`.
- The inbox pane is focused, which is true at startup and false after Enter or `ctl draft`.

- **Inbox query.** Press `/`, type `billing`, and press Enter. Run `bun .cursor/skills/verify-crisp-tui/harness.ts keys slash`, `bun .cursor/skills/verify-crisp-tui/harness.ts keys type -- billing`, and `bun .cursor/skills/verify-crisp-tui/harness.ts keys enter`. Then run `bun .cursor/skills/verify-crisp-tui/harness.ts wait screen -- 'Inbox · page 1 · billing'` and `bun .cursor/skills/verify-crisp-tui/harness.ts wait pty -- 'Search: billing'`. `ctl conversations` is one object whose `session_id` is `session_demo_1`. `ctl screen` contains `Demo Customer A [unresolved] session_demo_1` and does not contain `session_demo_2`.
- **Empty query result.** Press `/`, delete the seven prefilled characters of `billing`, type `zzznone`, and press Enter. Run `bun .cursor/skills/verify-crisp-tui/harness.ts keys slash`, `bun .cursor/skills/verify-crisp-tui/harness.ts keys backspace --repeat 7`, `bun .cursor/skills/verify-crisp-tui/harness.ts keys type -- zzznone`, and `bun .cursor/skills/verify-crisp-tui/harness.ts keys enter`. Then run `bun .cursor/skills/verify-crisp-tui/harness.ts wait screen -- 'Inbox · page 1 · zzznone'` and `bun .cursor/skills/verify-crisp-tui/harness.ts wait pty -- 'No conversations on this page.'`. `ctl conversations` is `[]`. `ctl screen` still contains `Conversation: Demo Customer A (session_demo_1)`.
- **Clear back to all.** Press `/`, delete the seven prefilled characters of `zzznone`, and press Enter. Run `bun .cursor/skills/verify-crisp-tui/harness.ts keys slash`, `bun .cursor/skills/verify-crisp-tui/harness.ts keys backspace --repeat 7`, and `bun .cursor/skills/verify-crisp-tui/harness.ts keys enter`. Then run `bun .cursor/skills/verify-crisp-tui/harness.ts wait screen -- 'Inbox · page 1 · all'`. The screen text contains `session_demo_1`, `session_demo_2`, and `session_demo_3`.
- **Messages pane query.** Focus messages, press `/`, type `teammates`, and press Enter. Run `bun .cursor/skills/verify-crisp-tui/harness.ts keys tab`, `bun .cursor/skills/verify-crisp-tui/harness.ts keys slash`, `bun .cursor/skills/verify-crisp-tui/harness.ts keys type -- teammates`, and `bun .cursor/skills/verify-crisp-tui/harness.ts keys enter`. Then run `bun .cursor/skills/verify-crisp-tui/harness.ts wait screen -- 'Inbox · page 1 · teammates'`. `ctl conversations` is one object whose `session_id` is `session_demo_2`. `ctl screen` contains `Demo Customer B [unresolved] session_demo_2` and `Conversation: Demo Customer A (session_demo_1)`. Search does not close the conversation that was already open.
- **Proof.** Run `bun .cursor/skills/verify-crisp-tui/harness.ts capture search --action "slash from messages, query teammates"`. `search/screen.txt` contains `Inbox · page 1 · teammates` and `session_demo_2`. `search/pty.log` contains `Search: teammates`.

## Gotchas

- `/` prefills the current query, and typed characters append to it. Backspace the prefilled text before typing a new query. `billing` and `zzznone` are each seven characters.
- `/` from the composer inserts a slash into the draft. Press `esc` and start from the inbox before this recipe.
- A one-character query can match a session id or an unread count. Use `billing`, `teammates`, or `zzznone`.
- Search does not close the open conversation. The message pane can still name a customer who is not in the filtered inbox. Prove the filter with `ctl conversations`, and prove an empty inbox with `[]` plus the PTY line `No conversations on this page.`.
- After a search, the old rows remain in the PTY log. Prove the current filter with `ctl screen`.
