# Reply and internal note

A person focuses the composer, types, and presses Enter to send. Ctrl+N switches that draft between a customer reply and an internal note. The send shows up as a new message in the open conversation.

## Sub-features

- `reply-from-enter` opens the highlighted inbox row into the composer and sends a reply.
- `reply-from-tab` reaches the composer with Tab and sends a second reply.
- `note-from-ctrl-n` toggles the composer to an internal note and sends it.
- `reply-newline` inserts a line break with Ctrl+J without sending.

## How to get to it (user POV)

- In the inbox, press Enter on the highlighted row. The composer is focused. Type, then press Enter to send.
- Press Tab until the composer is focused. From the inbox that is the second Tab. Type, then press Enter to send.
- Press Ctrl+N to switch between `Reply` and `Internal note`, then type and press Enter.
- Press Ctrl+J in the composer for a newline. Shift+Enter and Alt+Enter are terminal-dependent; drive Ctrl+J.

## Driving it with verify-crisp-tui

Preconditions:

- Fresh launch, with doctor `"ok":true` and `"activeSession":"session_demo_1"`.
- The inbox pane is focused.

- **Reply from the inbox row.** Press Enter, type, and press Enter again. Run `bun .cursor/skills/verify-crisp-tui/harness.ts keys enter`, `bun .cursor/skills/verify-crisp-tui/harness.ts keys type -- 'Checking the invoice now.'`, and `bun .cursor/skills/verify-crisp-tui/harness.ts wait screen -- 'Reply draft: Checking the invoice now.'`. The draft is still unsent: `ctl messages` does not contain `Checking the invoice now.`. Then run `bun .cursor/skills/verify-crisp-tui/harness.ts keys enter`, `bun .cursor/skills/verify-crisp-tui/harness.ts wait status -- 'Reply sent'`, `bun .cursor/skills/verify-crisp-tui/harness.ts wait pty -- 'Reply sent'`, and `bun .cursor/skills/verify-crisp-tui/harness.ts wait screen -- 'You: Checking the invoice now.'`. `ctl messages` includes an object with `content` `Checking the invoice now.`, `type` `text`, and `from` `operator`.
- **Newline without send.** Type two lines joined by Ctrl+J and do not press Enter yet. Run `bun .cursor/skills/verify-crisp-tui/harness.ts keys type -- 'Line one'`, `bun .cursor/skills/verify-crisp-tui/harness.ts keys ctrl-j`, `bun .cursor/skills/verify-crisp-tui/harness.ts keys type -- 'line two'`, and `bun .cursor/skills/verify-crisp-tui/harness.ts wait screen -- 'line two'`. Then run `bun .cursor/skills/verify-crisp-tui/harness.ts ctl -- state`. Exit 0. `draft.text` is `Line one\nline two`. `ctl messages` does not contain `Line one`.
- **Send the two-line reply.** Press Enter. Run `bun .cursor/skills/verify-crisp-tui/harness.ts keys enter` and `bun .cursor/skills/verify-crisp-tui/harness.ts wait status -- 'Reply sent'`. `ctl messages` contains `Line one\nline two` as one message `content`.
- **Second reply through Tab.** Focus the inbox, Tab to the composer, type, and send. Run `bun .cursor/skills/verify-crisp-tui/harness.ts keys esc`, `bun .cursor/skills/verify-crisp-tui/harness.ts keys tab`, `bun .cursor/skills/verify-crisp-tui/harness.ts keys tab`, `bun .cursor/skills/verify-crisp-tui/harness.ts keys type -- 'Sent after Tab.'`, and `bun .cursor/skills/verify-crisp-tui/harness.ts keys enter`. Then run `bun .cursor/skills/verify-crisp-tui/harness.ts wait status -- 'Reply sent'` and `bun .cursor/skills/verify-crisp-tui/harness.ts wait messages -- 'Sent after Tab.'`.
- **Internal note.** Press Ctrl+N, type, and press Enter. Run `bun .cursor/skills/verify-crisp-tui/harness.ts keys ctrl-n`, `bun .cursor/skills/verify-crisp-tui/harness.ts keys type -- 'Note about the invoice.'`, and `bun .cursor/skills/verify-crisp-tui/harness.ts wait screen -- 'Internal note draft: Note about the invoice.'`. `ctl messages` does not yet contain `Note about the invoice.`. Then run `bun .cursor/skills/verify-crisp-tui/harness.ts keys enter`, `bun .cursor/skills/verify-crisp-tui/harness.ts wait status -- 'Internal note saved'`, `bun .cursor/skills/verify-crisp-tui/harness.ts wait pty -- 'Internal note saved'`, and `bun .cursor/skills/verify-crisp-tui/harness.ts wait screen -- 'You [internal note]: Note about the invoice.'`. The new message has `type` `note`.
- **Proof.** Run `bun .cursor/skills/verify-crisp-tui/harness.ts wait pty -- 'Internal note saved'`, then `bun .cursor/skills/verify-crisp-tui/harness.ts capture reply-and-note --action "Enter reply, Tab reply, Ctrl+N note"`. `reply-and-note/messages.json` contains `Checking the invoice now.`, `Sent after Tab.`, and `Note about the invoice.`. `reply-and-note/screen.txt` contains `Internal note saved`.

## Gotchas

- The first Enter at startup opens the row. The Enter that sends is the one after the draft text is visible in `ctl screen`.
- Typing while the inbox is focused does not fill the composer. `j` moves the highlight.
- Ctrl+N toggles the open conversation's draft mode and does not by itself focus the composer. Focus the composer before typing.
- Ctrl+J in the composer inserts a newline. Enter sends the whole draft, including that newline.
- A failed demo send is not drivable here. Demo replies succeed. Prove the send by reading `ctl messages`, not by the status line alone.
