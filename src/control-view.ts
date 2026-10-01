import type { Store } from "./store"
import { label, messageText, type Conversation } from "./types"

export interface PageOptions { offset?: number; limit?: number; revision?: number }
const preview = (text: string, length = 512) => text.length > length ? text.slice(0, length) + "…" : text
function conversation(value: Conversation) {
  return { session_id: value.session_id, label: preview(label(value)), state: value.state,
    unread: value.unread?.operator ?? 0 }
}
export function controlState(store: Store) {
  const s = store.state, draft = store.draft()
  // Protocol 2 is deliberately independent of internal State and never embeds histories or draft text.
  return { protocol: 2, revision: s.revision, source: preview(s.source), readOnly: s.readOnly,
    selectedSession: s.selectedSession, conversationLoading: s.conversationLoading,
    active: s.active ? conversation(s.active) : null, realtime: s.realtime,
    query: preview(s.query), page: s.page, loading: s.loading, sending: s.sending,
    counts: { conversations: s.conversations.length, messages: s.messages.length, drafts: Object.keys(s.drafts).length },
    draft: { note: draft.note, length: draft.text.length },
    error: preview(s.error), errorSource: s.errorSource, status: preview(s.status),
    textTruncated: [s.source, s.query, s.error, s.status, s.active ? label(s.active) : ""].some(text => text.length > 512) }
}
function checkRevision(store: Store, revision?: number) {
  if (revision !== undefined && revision !== store.state.revision) throw new Error("State changed; read state and restart pagination")
}
export function controlPage(store: Store, resource: "conversations" | "messages" | "drafts", options: PageOptions) {
  checkRevision(store, options.revision)
  const offset = options.offset ?? 0, limit = options.limit ?? 50
  if (limit > 100) throw new Error("Page limit must be at most 100")
  const s = store.state
  const rows = resource === "drafts" ? Object.entries(s.drafts) : s[resource]
  const summaries = rows.slice(offset, offset + limit).map((_, i) => {
    const index = offset + i
    if (resource === "conversations") {
      const value = s.conversations[index]!
      return { index, ...conversation(value), previewTruncated: label(value).length > 512 }
    }
    if (resource === "drafts") {
      const [session, draft] = (rows as [string, { text: string; note: boolean }][])[index]!
      return { session, note: draft.note, length: draft.text.length }
    }
    const message = s.messages[index]!, content = messageText(message), nickname = message.user?.nickname ?? ""
    return { index, fingerprint: message.fingerprint, timestamp: message.timestamp,
      from: message.from, type: message.type, user: { nickname: preview(nickname) },
      content: preview(content, 2048), previewTruncated: content.length > 2048 || nickname.length > 512 }
  })
  const items: typeof summaries = []
  let bytes = 0
  for (const item of summaries) {
    const size = Buffer.byteLength(JSON.stringify(item))
    if (bytes + size > 512 * 1024) {
      if (!items.length) throw new Error("Record summary too large; use ctl read")
      break
    }
    items.push(item); bytes += size
  }
  return { revision: s.revision, session: s.active?.session_id ?? null, items, total: rows.length,
    offset, nextOffset: offset + items.length < rows.length ? offset + items.length : null }
}
/** Read lossless JSON in bounded UTF-16 slices, without changing the selected conversation. */
export function controlRead(store: Store, resource: string, key: string, options: PageOptions) {
  checkRevision(store, options.revision)
  const offset = options.offset ?? 0, limit = options.limit ?? 16_384
  if (limit > 16_384) throw new Error("Read limit must be at most 16384")
  let value: unknown
  if (resource === "drafts") {
    if (Object.hasOwn(store.state.drafts, key)) value = store.state.drafts[key]
  } else if (resource === "messages" || resource === "conversations") {
    if (!/^\d+$/.test(key) || !Number.isSafeInteger(Number(key))) throw new Error("Record key must be a non-negative integer")
    value = store.state[resource][Number(key)]
  } else throw new Error("Resource must be conversations, messages or drafts")
  if (value === undefined) throw new Error("Record not loaded")
  const text = JSON.stringify(value), chunk = text.slice(offset, offset + limit)
  return { revision: store.state.revision, encoding: "json", offset, text: chunk, total: text.length,
    nextOffset: offset + chunk.length < text.length ? offset + chunk.length : null }
}
export function controlScreen(store: Store) {
  const text = store.screen()
  return text.length <= 65_536 ? text : text.slice(0, 65_536) + "\n[Screen truncated; use ctl messages/conversations/drafts and ctl read.]"
}
