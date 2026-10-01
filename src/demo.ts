import type { Conversation, CrispClient, Message } from "./types"

export function demoClient(): CrispClient {
  const conversations: Conversation[] = [
    { session_id: "session_demo_1", state: "unresolved", meta: { nickname: "Demo Customer A", email: "customer-a@example.com", segments: ["billing"] }, last_message: "Can you help me find my invoice?", unread: { operator: 1 } },
    { session_id: "session_demo_2", state: "unresolved", meta: { nickname: "Demo Customer B", email: "customer-b@example.com", segments: ["onboarding"] }, last_message: "How do I invite my teammates?", unread: { operator: 2 } },
    { session_id: "session_demo_3", state: "resolved", meta: { nickname: "Demo Customer C", segments: ["feedback"] }, last_message: "That worked. Thank you!" },
  ]
  const histories: Record<string, Message[]> = Object.fromEntries(conversations.map((c, i) => [c.session_id, [
    { fingerprint: i + 1, timestamp: Date.now() - 60_000, from: "user", type: "text", content: c.last_message, user: { nickname: c.meta?.nickname } },
  ]]))
  const get = (id: string) => {
    const c = conversations.find(c => c.session_id === id)
    if (!c) throw new Error(`Unknown demo conversation: ${id}`)
    return c
  }
  return {
    label: "DEMO · local only",
    async list(page, query) { return structuredClone(page === 1 ? conversations.filter(c => JSON.stringify(c).toLowerCase().includes(query.toLowerCase())) : []) },
    async get(id) { return structuredClone(get(id)) },
    async messages(id) { get(id); return structuredClone(histories[id]!) },
    async reply(id, text, note) {
      get(id).last_message = text
      histories[id]!.push({ fingerprint: Date.now(), timestamp: Date.now(), from: "operator", type: note ? "note" : "text", content: text, user: { nickname: "You" } })
    },
    async state(id, resolved) { get(id).state = resolved ? "resolved" : "unresolved" },
    async read(id) { get(id).unread = { operator: 0 } },
  }
}
