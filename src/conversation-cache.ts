import type { Conversation, Message } from "./types"

/** Per-store, in-memory snapshots only. Every navigation still revalidates with Crisp. */
export class ConversationCache {
  private entries = new Map<string, { active: Conversation; messages: Message[]; bytes: number }>()
  private bytes = 0
  constructor(private maxEntries = 20, private maxBytes = 8 * 1024 * 1024) {}
  get(session: string) {
    const entry = this.entries.get(session)
    if (entry) { this.entries.delete(session); this.entries.set(session, entry) }
    return entry
  }
  delete(session: string) {
    const entry = this.entries.get(session)
    if (entry) { this.bytes -= entry.bytes; this.entries.delete(session) }
  }
  set(active: Conversation, messages: Message[]) {
    this.delete(active.session_id)
    const bytes = Buffer.byteLength(JSON.stringify({ active, messages }))
    if (bytes > this.maxBytes) return
    this.entries.set(active.session_id, { active, messages, bytes })
    this.bytes += bytes
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) this.delete(this.entries.keys().next().value!)
  }
}
