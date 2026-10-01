# Agent draft

An agent puts a reply or an internal note into the open composer. The draft stays unsent until a person presses Enter. A second draft for the same conversation is refused until the agent passes `--replace`, and replace still does not send.

## Sub-features

- `draft-reply-unsent` places a reply draft in Demo Customer B's composer and does not add a message.
- `draft-refuse-overwrite` rejects a second draft that omits `--replace`.
- `draft-send-enter` sends that reply when the person presses Enter.
- `draft-note-send` places an internal note with `--note` and sends it with Enter.
- `draft-replace-unsent` replaces Demo Customer A's draft and leaves that conversation's messages unchanged.

## How to get to it (user POV)

- With the demo inbox running, run `ctl draft SESSION TEXT`.
- Run `ctl draft SESSION TEXT --note` for an internal note.
- Run `ctl draft SESSION TEXT --replace` to overwrite a non-empty draft.
- Press Enter in the composer to send. The draft command focuses the composer.
- There is no agent send command on this screen.

## Driving it with verify-crisp-tui

Preconditions:

- Fresh launch, with doctor `"ok":true`, `"readOnly":false`, and `"activeSession":"session_demo_1"`.

- **Prepare a reply draft.** Run `bun .cursor/skills/verify-crisp-tui/harness.ts ctl -- draft session_demo_2 'Let me help you check your settings.'`. Exit 0. Stdout JSON has `"sent":false`, `"session":"session_demo_2"`, and `"text":"Let me help you check your settings."`.
- **Show it in the composer.** Run `bun .cursor/skills/verify-crisp-tui/harness.ts wait screen -- 'Reply draft: Let me help you check your settings.'`, `bun .cursor/skills/verify-crisp-tui/harness.ts wait pty -- 'Let me help you check your settings.'`, and `bun .cursor/skills/verify-crisp-tui/harness.ts wait status -- 'Agent draft ready · review and press Enter to send'`. Each exits 0.
- **Confirm it was not sent.** Run `bun .cursor/skills/verify-crisp-tui/harness.ts ctl -- messages`. Exit 0. The array has one object whose `content` is `How do I invite my teammates?`. The output does not contain `Let me help you check your settings.`.
- **Refuse an overwrite.** Run `bun .cursor/skills/verify-crisp-tui/harness.ts ctl -- draft session_demo_2 'overwrite'`. Exit 1. Stderr contains `Draft already exists; use --replace to overwrite it`.
- **Keep the original draft.** Run `bun .cursor/skills/verify-crisp-tui/harness.ts wait screen -- 'Reply draft: Let me help you check your settings.'`. Exit 0.
- **Snapshot the unsent draft.** Run `bun .cursor/skills/verify-crisp-tui/harness.ts capture draft-ready --action "ctl draft session_demo_2 reply text"`. `draft-ready/screen.txt` contains `Reply draft: Let me help you check your settings.`. `draft-ready/messages.json` does not contain that sentence.
- **Send with Enter.** Run `bun .cursor/skills/verify-crisp-tui/harness.ts keys enter`, `bun .cursor/skills/verify-crisp-tui/harness.ts wait status -- 'Reply sent'`, `bun .cursor/skills/verify-crisp-tui/harness.ts wait messages -- 'Let me help you check your settings.'`, and `bun .cursor/skills/verify-crisp-tui/harness.ts wait screen -- 'You: Let me help you check your settings.'`. Each exits 0. The message object has `type` `text` and `from` `operator`. `ctl state` has `draft.text` equal to `""` and `status` `Reply sent`.
- **Snapshot the sent reply.** Run `bun .cursor/skills/verify-crisp-tui/harness.ts capture reply-sent --action "keys enter sends the reply draft"`. `reply-sent/state.json` has `"status":"Reply sent"` and an empty draft `text`.
- **Draft a note and send it.** Run `bun .cursor/skills/verify-crisp-tui/harness.ts ctl -- draft session_demo_2 'Internal context for the teammate invite.' --note`. Exit 0. Stdout has `"note":true` and `"sent":false`. Run `bun .cursor/skills/verify-crisp-tui/harness.ts wait screen -- 'Internal note draft: Internal context for the teammate invite.'` and `bun .cursor/skills/verify-crisp-tui/harness.ts wait pty -- 'Internal context for the teammate invite.'`. `ctl messages` does not yet contain `Internal context for the teammate invite.`. Run `bun .cursor/skills/verify-crisp-tui/harness.ts keys enter`, `bun .cursor/skills/verify-crisp-tui/harness.ts wait status -- 'Internal note saved'`, and `bun .cursor/skills/verify-crisp-tui/harness.ts wait screen -- 'You [internal note]: Internal context for the teammate invite.'`. The new message has `type` `note`.
- **Snapshot the sent note.** Run `bun .cursor/skills/verify-crisp-tui/harness.ts capture note-sent --action "ctl draft --note then keys enter"`. `note-sent/messages.json` contains `Internal context for the teammate invite.` and `"type":"note"`.
- **Replace a draft without sending.** Run `bun .cursor/skills/verify-crisp-tui/harness.ts ctl -- draft session_demo_1 'First draft'`. Exit 0, with `"sent":false`. Run `bun .cursor/skills/verify-crisp-tui/harness.ts ctl -- draft session_demo_1 'Revised draft' --replace`. Exit 0, with `"sent":false` and `"text":"Revised draft"`. Run `bun .cursor/skills/verify-crisp-tui/harness.ts wait screen -- 'Reply draft: Revised draft'`. `ctl messages` contains `Can you help me find my invoice?` and does not contain `First draft` or `Revised draft`. Do not press Enter after this step.
- **Proof.** Run `bun .cursor/skills/verify-crisp-tui/harness.ts capture replace-unsent --action "ctl draft --replace without Enter"`. `replace-unsent/screen.txt` contains `Reply draft: Revised draft`. `replace-unsent/messages.json` contains `Can you help me find my invoice?` and does not contain `Revised draft`.

## Gotchas

- `draft` never sends. The only send in this recipe is `keys enter`, and only after the unsent snapshot.
- A second draft without `--replace` exits 1 and leaves the original text. `--replace` still does not send.
- Do not pass `--demo` to `ctl`. Do not use `cli reply`. There is no `ctl` send verb.
- After `draft`, the composer is focused. `j` or `/` changes the draft text instead of moving the inbox or opening search.
- Drafts are stored per conversation. Replacing the Demo Customer A draft does not remove the messages already sent to Demo Customer B.
- The PTY log still contains the unsent draft after Enter. Prove the send with `ctl messages` and `ctl screen`.
- Demo text disappears when the TUI exits. Capture before cleanup.
