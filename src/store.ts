import { clean, label, messageText, type Conversation, type CrispClient, type Message } from "./types"
import { readOnlyClient } from "./readonly"

export interface Draft { text: string; note: boolean }
export interface State {
  readOnly: boolean
  realtime: "off" | "connecting" | "authenticated" | "reconnecting" | "error"
  source: string; conversations: Conversation[]; active: Conversation | null; messages: Message[]
  drafts: Record<string, Draft>; query: string; page: number; loading: boolean; sending: boolean
  error: string; status: string; revision: number
}
export class Store {
  state: State
  private listeners = new Set<() => void>()
  private selection = 0
  private listing = 0
  private messageVersion = 0
  private refreshTask?: Promise<void>
  constructor(readonly client: CrispClient) {
    if (client.readOnly) this.client = readOnlyClient(client)
    this.state = { realtime: "off", readOnly: !!client.readOnly, source: client.label, conversations: [], active: null, messages: [], drafts: {}, query: "", page: 1, loading: false, sending: false, error: "", status: client.readOnly ? "Read-only · no changes will be sent to Crisp" : "Ready", revision: 0 }
  }
  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  update(patch: Partial<State>) {
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 }
    for (const fn of this.listeners) fn()
  }
  async perform(action: () => Promise<unknown>) {
    try { await action() } catch (e) { this.update({ error: clean(e instanceof Error ? e.message : String(e)) }) }
  }
  async list(query = this.state.query, page = this.state.page) {
    const version = ++this.listing
    this.update({ loading: true, error: "", query, page })
    try {
      const conversations = await this.client.list(page, query)
      if (version !== this.listing) return
      this.update({ conversations })
      if (!this.state.active && conversations[0]) await this.open(conversations[0].session_id)
    } finally { if (version === this.listing) this.update({ loading: false }) }
  }
  async open(session: string) {
    const version = ++this.selection
    // Clear old content before loading; a slow previous response must not change this selection.
    this.update({ active: null, messages: [], error: "", status: "Loading conversation…" })
    const [active, messages] = await Promise.all([this.client.get(session), this.client.messages(session)])
    if (version !== this.selection) return
    this.update({ active, messages, status: `Opened ${clean(label(active))}` })
  }
  draft(): Draft { return this.state.drafts[this.state.active?.session_id ?? ""] ?? { text: "", note: false } }
  setDraft(text: string, note = this.draft().note) {
    const id = this.state.active?.session_id
    if (!id) throw new Error("Open a conversation first")
    if (this.state.sending) throw new Error("Wait for the current send to finish")
    this.update({ drafts: { ...this.state.drafts, [id]: { text, note } } })
  }
  async send() {
    const id = this.state.active?.session_id
    const draft = this.draft()
    if (!id || !draft.text.trim() || this.state.sending) return
    this.messageVersion++
    this.update({ sending: true, error: "" })
    try {
      await this.client.reply(id, draft.text, draft.note)
      // Clear only after an acknowledged send. Never retry a failed write automatically.
      this.update({ drafts: { ...this.state.drafts, [id]: { ...draft, text: "" } }, status: draft.note ? "Internal note saved" : "Reply sent" })
      try { await this.refreshMessages() } catch { this.update({ error: "Sent successfully; refresh failed. Do not resend." }) }
    } finally { this.update({ sending: false }) }
  }
  async changeState() {
    const active = this.state.active
    if (!active) return
    const resolved = active.state !== "resolved"
    await this.client.state(active.session_id, resolved)
    this.messageVersion++
    const state = resolved ? "resolved" : "unresolved"
    this.update({
      active: this.state.active?.session_id === active.session_id ? { ...this.state.active, state } : this.state.active,
      conversations: this.state.conversations.map(c => c.session_id === active.session_id ? { ...c, state } : c),
      status: resolved ? "Conversation resolved" : "Conversation reopened",
    })
  }
  async markRead() {
    const id = this.state.active?.session_id
    if (!id) return
    await this.client.read(id)
    this.update({ conversations: this.state.conversations.map(c => c.session_id === id ? { ...c, unread: { operator: 0 } } : c), status: "Marked read" })
  }
  private async refreshMessages() {
    const id = this.state.active?.session_id
    const version = this.selection
    if (!id) return
    const messageVersion = ++this.messageVersion
    const [active, messages] = await Promise.all([this.client.get(id), this.client.messages(id)])
    if (version === this.selection && messageVersion === this.messageVersion) this.update({ active, messages })
  }
  refresh(): Promise<void> {
    if (this.refreshTask) return this.refreshTask
    this.refreshTask = (async () => {
      await this.list()
      await this.refreshMessages()
      this.update({ error: "" })
    })().finally(() => { this.refreshTask = undefined })
    return this.refreshTask
  }
  async refreshAfterCurrent() {
    if (this.refreshTask) await this.refreshTask.catch(() => {})
    return this.refresh()
  }
  snapshot() { return { ...this.state, draft: this.draft(), protocol: 1 } }
  screen() {
    const s = this.state
    return clean([
      `Crisp | ${s.source}${s.readOnly ? " | READ ONLY" : ""}`, `Inbox · page ${s.page} · ${s.query || "all"}`,
      ...s.conversations.map(c => `${c.session_id === s.active?.session_id ? ">" : " "} ${label(c)} [${c.state || "unknown"}] ${c.session_id}`),
      s.active ? `Conversation: ${label(s.active)} (${s.active.session_id})` : "No conversation open",
      ...s.messages.map(m => `${m.user?.nickname || m.from || "unknown"}${m.type === "note" ? " [internal note]" : ""}: ${messageText(m)}`),
      `${this.draft().note ? "Internal note" : "Reply"} draft: ${this.draft().text}`,
      s.error || s.status,
    ].join("\n"))
  }
}
