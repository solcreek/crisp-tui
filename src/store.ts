import { clean, label, messageText, type Conversation, type CrispClient, type Message } from "./types"
import { readOnlyClient } from "./readonly"

export interface Draft { text: string; note: boolean }
export interface State {
  readOnly: boolean
  selectedSession: string | null
  conversationLoading: boolean
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
  private mutationVersion = 0
  private messageVersion = 0
  private refreshTask?: Promise<void>
  constructor(readonly client: CrispClient) {
    if (client.readOnly) this.client = readOnlyClient(client)
    this.state = { selectedSession: null, conversationLoading: false, realtime: "off", readOnly: !!client.readOnly, source: client.label, conversations: [], active: null, messages: [], drafts: {}, query: "", page: 1, loading: false, sending: false, error: "", status: client.readOnly ? "Read-only · no changes will be sent to Crisp" : "Ready", revision: 0 }
  }
  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  update(patch: Partial<State>) {
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 }
    for (const fn of this.listeners) fn()
  }
  async perform(action: () => Promise<unknown>) {
    try { await action() } catch (e) { this.update({ error: clean(e instanceof Error ? e.message : String(e)) }) }
  }
  private async fetchList(query: string, page: number) {
    const version = ++this.listing
    this.update({ loading: true, error: "", query, page })
    try {
      while (version === this.listing) {
        const mutation = this.mutationVersion
        const conversations = await this.client.list(page, query)
        if (version !== this.listing) return
        // A completed write invalidates any list requested before its acknowledgement.
        if (mutation !== this.mutationVersion) continue
        this.update({ conversations })
        return
      }
    } catch (error) {
      if (version === this.listing) throw error
    } finally { if (version === this.listing) this.update({ loading: false }) }
  }
  private async selectInitialConversation() {
    const first = this.state.conversations[0]
    if (this.state.selectedSession === null && first) {
      await this.open(first.session_id)
      return true
    }
    return false
  }
  async list(query = this.state.query, page = this.state.page) {
    await this.fetchList(query, page)
    await this.selectInitialConversation()
  }
  async open(session: string) {
    const version = ++this.selection
    this.messageVersion++
    // Selection is an intent; it survives while the matching data is loading.
    this.update({ selectedSession: session, conversationLoading: true, active: null, messages: [], error: "", status: "Loading conversation…" })
    try {
      while (version === this.selection) {
        const mutation = this.mutationVersion
        const [active, messages] = await Promise.all([this.client.get(session), this.client.messages(session)])
        if (version !== this.selection) return
        if (mutation !== this.mutationVersion) continue
        this.update({ active, messages, status: `Opened ${clean(label(active))}` })
        return
      }
    } catch (error) {
      if (version === this.selection) throw error
    } finally {
      if (version === this.selection) this.update({ conversationLoading: false })
    }
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
      this.mutationVersion++
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
    this.mutationVersion++
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
    this.mutationVersion++
    this.messageVersion++
    this.update({ active: this.state.active?.session_id === id ? { ...this.state.active, unread: { operator: 0 } } : this.state.active, conversations: this.state.conversations.map(c => c.session_id === id ? { ...c, unread: { operator: 0 } } : c), status: "Marked read" })
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
      await this.fetchList(this.state.query, this.state.page)
      if (!await this.selectInitialConversation() && !this.state.conversationLoading) await this.refreshMessages()
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
