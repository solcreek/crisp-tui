import { clean, label, messageText, type Conversation, type CrispClient, type Message, type RealtimeStatus } from "./types"
import { readOnlyClient } from "./readonly"
import { ConversationCache } from "./conversation-cache"
import { metrics as defaultMetrics, type Metrics } from "./performance"
import { reuseRecord, reuseRecords } from "./reconcile"

type ErrorSource = "list" | "conversation" | "send" | "state" | "read" | "realtime" | "other"
const cachedFailureStatus = "Showing saved conversation; update failed · refresh to retry"
class OperationError extends Error {
  constructor(error: unknown, readonly source: ErrorSource, readonly current: () => boolean) {
    super(error instanceof Error ? error.message : String(error))
  }
}

export interface Draft { text: string; note: boolean }
export interface State {
  readOnly: boolean
  selectedSession: string | null
  conversationLoading: boolean
  conversationCached: boolean
  messagesReady: boolean
  messagesLoading: boolean
  detailsLoading: boolean
  initialReadComplete: boolean
  realtimeSynced: boolean
  realtime: "off" | "connecting" | "authenticated" | "reconnecting" | "error"
  source: string; conversations: Conversation[]; active: Conversation | null; messages: Message[]
  drafts: Record<string, Draft>; query: string; page: number; loading: boolean; sending: boolean
  error: string; errorSource: ErrorSource | null; status: string; revision: number
}
export class Store {
  state: State
  private listeners = new Set<() => void>()
  private operationSequence = 0
  private operations = new Map<ErrorSource, number>()
  private errors = new Map<ErrorSource, { text: string; order: number }>()
  private selection = 0
  private listing = 0
  private mutationVersion = 0
  private messageVersion = 0
  private conversationRequest = 0
  private refreshTask?: Promise<void>
  private cache = new ConversationCache()
  private openTask?: { session: string; promise: Promise<void> }
  private readEpoch = 0
  private listRead?: { epoch: number; query: string; page: number }
  private conversationRead?: { session: string; details: number; messages: number }
  constructor(readonly client: CrispClient, readonly metrics: Metrics = defaultMetrics) {
    if (client.readOnly) this.client = readOnlyClient(client)
    this.state = { selectedSession: null, conversationLoading: false, conversationCached: false, messagesReady: false, messagesLoading: false, detailsLoading: false, initialReadComplete: false, realtimeSynced: false, realtime: "off", readOnly: !!client.readOnly, source: client.label, conversations: [], active: null, messages: [], drafts: {}, query: "", page: 1, loading: false, sending: false, error: "", errorSource: null, status: client.readOnly ? "Read-only · no changes will be sent to Crisp" : "Ready", revision: 0 }
  }
  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  update(patch: Partial<State>) {
    if (patch.error !== undefined) {
      const source = patch.errorSource ?? "other"
      if (patch.error) this.errors.set(source, { text: patch.error, order: ++this.operationSequence })
      else this.errors.delete(source)
      // Preserve independent failures. Writes take precedence over background diagnostics.
      const priority = (source: ErrorSource) => ["send", "state", "read"].includes(source) ? 1 : 0
      const latest = [...this.errors].sort(([a, x], [b, y]) => priority(b) - priority(a) || y.order - x.order)[0]
      patch = { ...patch, error: latest?.[1].text ?? "", errorSource: latest?.[0] ?? null }
    }
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 }
    this.metrics.sync("state.notify", () => { for (const fn of this.listeners) fn() })
  }
  private reportError(error: unknown) {
    if (error instanceof OperationError && !error.current()) return
    this.update({ error: clean(error instanceof Error ? error.message : String(error)),
      errorSource: error instanceof OperationError ? error.source : null })
  }
  private operation(source: ErrorSource, valid = () => true) {
    const sequence = ++this.operationSequence
    this.operations.set(source, sequence)
    const current = () => valid() && this.operations.get(source) === sequence
    return {
      failure: (error: unknown) => new OperationError(error, source, current),
      clear: () => { if (current() && this.errors.has(source)) this.update({ error: "", errorSource: source }) },
    }
  }
  setRealtime(status: RealtimeStatus) {
    const operation = this.operation("realtime")
    this.update({ realtime: status.state, ...(status.state !== "authenticated" ? { realtimeSynced: false } : {}) })
    if (status.message) this.reportError(operation.failure(status.message))
    else if (status.state === "authenticated") operation.clear()
  }
  async perform(action: () => Promise<unknown>) {
    try { await action() } catch (error) { this.reportError(error) }
  }
  private async fetchList(query: string, page: number) {
    const version = ++this.listing
    const operation = this.operation("list", () => version === this.listing)
    this.update({ loading: true, query, page })
    try {
      while (version === this.listing) {
        const mutation = this.mutationVersion
        const epoch = this.readEpoch
        const conversations = await this.metrics.measure("client.list", () => this.client.list(page, query))
        if (version !== this.listing) return
        // A completed write invalidates any list requested before its acknowledgement.
        if (mutation !== this.mutationVersion) continue
        this.listRead = { epoch, query, page }
        this.update({ conversations: this.metrics.sync("state.reconcile", () => reuseRecords(this.state.conversations, conversations, c => c.session_id)) })
        operation.clear()
        return
      }
    } catch (error) {
      if (version === this.listing) throw operation.failure(error)
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
  open(session: string): Promise<void> {
    if (this.state.selectedSession === session && this.openTask?.session === session) return this.openTask.promise
    const promise = this.loadConversation(session)
    const task = { session, promise }
    this.openTask = task
    // Clear the task on both paths without creating an unhandled rejected promise.
    const clear = () => { if (this.openTask === task) this.openTask = undefined }
    void promise.then(clear, clear)
    return promise
  }
  private async loadConversation(session: string) {
    const version = ++this.selection
    this.messageVersion++
    const operation = this.operation("conversation", () => version === this.selection)
    // Selection is an intent; it survives while the matching data is loading.
    const cached = this.metrics.sync("cache.lookup", () => this.cache.get(session))
    this.conversationRead = { session, details: -1, messages: -1 }
    this.metrics.increment(cached ? "cache.hit" : "cache.miss")
    this.update({ selectedSession: session, conversationLoading: true, conversationCached: !!cached, messagesReady: !!cached, active: cached?.active ?? null,
      messages: cached?.messages ?? [], status: cached ? "Showing saved conversation · updating…" : "Loading conversation…" })
    try {
      while (version === this.selection) {
        const mutation = this.mutationVersion
        const [active, messages] = await this.fetchConversation(session, () => version === this.selection && mutation === this.mutationVersion)
        if (version !== this.selection) return
        if (mutation !== this.mutationVersion) continue
        const snapshot = this.saveConversation(active, messages)
        this.update({ ...snapshot, conversationCached: false, status: `Opened ${clean(label(active))}` })
        operation.clear()
        return
      }
    } catch (error) {
      if (version === this.selection) {
        this.update({ status: cached ? cachedFailureStatus : "Could not load conversation; refresh to retry" })
        throw operation.failure(error)
      }
    } finally {
      if (version === this.selection) {
        this.update({ conversationLoading: false })
        this.markInitialReadComplete()
        this.markRealtimeSynced()
      }
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
    const operation = this.operation("send")
    this.update({ sending: true })
    try {
      await this.client.reply(id, draft.text, draft.note)
      this.mutationVersion++
      this.cache.delete(id)
      operation.clear()
      // Clear only after an acknowledged send. Never retry a failed write automatically.
      this.update({ drafts: { ...this.state.drafts, [id]: { ...draft, text: "" } }, status: draft.note ? "Internal note saved" : "Reply sent" })
      try { await this.refreshMessages() } catch (error) {
        if (error instanceof OperationError) this.reportError(new OperationError("Sent successfully; refresh failed. Do not resend.", error.source, error.current))
      }
    } catch (error) { throw operation.failure(error) }
    finally { this.update({ sending: false }) }
  }
  async changeState() {
    const active = this.state.active
    if (!active) return
    const resolved = active.state !== "resolved"
    const operation = this.operation("state")
    try { await this.client.state(active.session_id, resolved) }
    catch (error) { throw operation.failure(error) }
    operation.clear()
    this.mutationVersion++
    this.cache.delete(active.session_id)
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
    const operation = this.operation("read")
    try { await this.client.read(id) }
    catch (error) { throw operation.failure(error) }
    operation.clear()
    this.mutationVersion++
    this.cache.delete(id)
    this.messageVersion++
    this.update({ active: this.state.active?.session_id === id ? { ...this.state.active, unread: { operator: 0 } } : this.state.active, conversations: this.state.conversations.map(c => c.session_id === id ? { ...c, unread: { operator: 0 } } : c), status: "Marked read" })
  }
  private saveConversation(active: Conversation, messages: Message[]) {
    const snapshot = this.metrics.sync("state.reconcile", () => ({
      active: reuseRecord(this.state.active, active),
      messages: reuseRecords(this.state.messages, messages, message => message.fingerprint),
    }))
    this.metrics.sync("cache.store", () => this.cache.set(snapshot.active, snapshot.messages))
    return snapshot
  }
  private async fetchConversation(session: string, current: () => boolean, requiredEpoch?: number): Promise<[Conversation, Message[]]> {
    const request = ++this.conversationRequest
    const previous = this.conversationRead?.session === session ? this.conversationRead : undefined
    const details = requiredEpoch === undefined || !this.state.active || !previous || previous.details < requiredEpoch
    const messages = requiredEpoch === undefined || !this.state.messagesReady || !previous || previous.messages < requiredEpoch
    if (!details) this.metrics.increment("reads.details_reused")
    if (!messages) this.metrics.increment("reads.messages_reused")
    const epoch = this.readEpoch
    this.update({ detailsLoading: details, messagesLoading: messages })
    const accept = (part: "details" | "messages") => {
      if (!this.conversationRead || this.conversationRead.session !== session) this.conversationRead = { session, details: -1, messages: -1 }
      this.conversationRead[part] = epoch
    }
    // Each successful resource becomes visible independently. Await both outcomes
    // before caching a complete snapshot or reporting the operation's failure.
    const outcomes = await Promise.allSettled([
      details ? this.metrics.measure("client.get", () => this.client.get(session)).then(active => {
        if (current()) {
          accept("details")
          this.update({ active: this.metrics.sync("state.reconcile", () => reuseRecord(this.state.active, active)), detailsLoading: false })
        }
        return active
      }).finally(() => { if (current() && this.state.detailsLoading) this.update({ detailsLoading: false }) }) : Promise.resolve(this.state.active!),
      messages ? this.metrics.measure("client.messages", () => this.client.messages(session)).then(items => {
        if (current()) {
          accept("messages")
          this.update({ messages: this.metrics.sync("state.reconcile", () => reuseRecords(this.state.messages, items, m => m.fingerprint)), messagesReady: true, messagesLoading: false })
        }
        return items
      }).finally(() => { if (current() && this.state.messagesLoading) this.update({ messagesLoading: false }) }) : Promise.resolve(this.state.messages),
    ])
    if (request === this.conversationRequest && this.state.selectedSession === session && (this.state.detailsLoading || this.state.messagesLoading)) {
      this.update({ detailsLoading: false, messagesLoading: false })
    }
    if (outcomes[0].status === "rejected") throw outcomes[0].reason
    if (outcomes[1].status === "rejected") throw outcomes[1].reason
    return [outcomes[0].value, outcomes[1].value]
  }
  private async refreshMessages(requiredEpoch?: number) {
    const id = this.state.selectedSession
    const version = this.selection
    if (!id) return
    const messageVersion = ++this.messageVersion
    const current = () => version === this.selection && messageVersion === this.messageVersion
    const operation = this.operation("conversation", current)
    try {
      const [active, messages] = await this.fetchConversation(id, current, requiredEpoch)
      if (current()) {
        const snapshot = this.saveConversation(active, messages)
        this.update({ ...snapshot, conversationCached: false,
          ...(this.state.status === cachedFailureStatus ? { status: `Opened ${clean(label(active))}` } : {}) })
        operation.clear()
      }
    } catch (error) { if (current()) throw operation.failure(error) }
  }
  refresh(requiredEpoch?: number): Promise<void> {
    if (this.refreshTask) return this.refreshTask
    this.refreshTask = this.metrics.measure("client.refresh", async () => {
      const selected = this.state.selectedSession !== null
      const list = requiredEpoch === undefined || !this.listFresh(requiredEpoch)
        ? this.fetchList(this.state.query, this.state.page)
        : (this.metrics.increment("reads.list_reused"), Promise.resolve())
      if (selected) {
        // A known selection does not depend on the inbox response. Drain both
        // branches before releasing refreshTask, including when either fails.
        const outcomes = await Promise.allSettled([list,
          this.state.conversationLoading ? Promise.resolve() : this.refreshMessages(requiredEpoch),
        ])
        const failures = outcomes.filter(result => result.status === "rejected")
        // Keep independent failures so recovering one cannot hide the other.
        for (const failure of failures.slice(1)) this.reportError(failure.reason)
        if (failures[0]) throw failures[0].reason
      } else {
        await list
        await this.selectInitialConversation()
      }
      this.markInitialReadComplete()
      this.markRealtimeSynced()
    }).finally(() => { this.refreshTask = undefined })
    return this.refreshTask
  }
  private listFresh(epoch: number) {
    return !!this.listRead && this.listRead.epoch >= epoch && this.listRead.query === this.state.query && this.listRead.page === this.state.page
  }
  private markInitialReadComplete() {
    const s = this.state, read = this.conversationRead
    if (s.initialReadComplete || !this.listFresh(0) || s.conversationLoading || s.messagesLoading || s.detailsLoading) return
    if ((!s.selectedSession && !s.conversations.length) ||
      (s.active?.session_id === s.selectedSession && s.messagesReady && read?.session === s.selectedSession && read.details >= 0 && read.messages >= 0)) {
      this.update({ initialReadComplete: true })
    }
  }
  private markRealtimeSynced() {
    const s = this.state, read = this.conversationRead, epoch = this.readEpoch
    if (!epoch || s.realtime !== "authenticated" || s.realtimeSynced || s.conversationLoading || s.detailsLoading || s.messagesLoading) return
    if (this.listFresh(epoch) && (!s.selectedSession ||
      (read?.session === s.selectedSession && read.details >= epoch && read.messages >= epoch))) this.update({ realtimeSynced: true })
  }
  /** Capture the observation boundary now, not after a debounce or in-flight read. */
  invalidateReads() {
    const epoch = ++this.readEpoch
    this.update({ realtimeSynced: false })
    return epoch
  }
  async refreshAfterCurrent(epoch = this.invalidateReads(), stopped = () => false) {
    while (this.refreshTask || this.openTask) {
      await (this.refreshTask ?? this.openTask!.promise).catch(() => {})
      if (stopped()) return
    }
    if (stopped()) return
    await this.refresh(epoch)
    if (!stopped()) this.markRealtimeSynced()
  }
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
