export interface Conversation {
  session_id: string
  state?: string
  meta?: { nickname?: string; email?: string; segments?: string[] }
  last_message?: string
  unread?: { operator?: number }
  updated_at?: number
}
export interface Message {
  fingerprint?: number | string
  timestamp?: number
  from?: string
  type?: string
  content: unknown
  user?: { nickname?: string }
}
export interface CrispClient {
  readonly label: string
  readonly readOnly?: boolean
  subscribe?: RealtimeSubscribe
  list(page: number, query: string): Promise<Conversation[]>
  get(session: string): Promise<Conversation>
  messages(session: string): Promise<Message[]>
  reply(session: string, text: string, note: boolean): Promise<unknown>
  state(session: string, resolved: boolean): Promise<unknown>
  read(session: string): Promise<unknown>
}
export interface RealtimeEvent { event: string; data: Record<string, unknown>; received_at: string }
export interface RealtimeStatus { state: "connecting" | "authenticated" | "reconnecting" | "error"; message?: string }
export type Cleanup = (() => void) & { done?: Promise<void> }
export type RealtimeSubscribe = (event: (value: RealtimeEvent) => void, status: (value: RealtimeStatus) => void) => Cleanup
export const label = (c: Conversation) => c.meta?.nickname || c.meta?.email || c.session_id
// Terminal control characters from remote content must never reach the display.
export const clean = (text: string) => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
export function messageText(m: Message): string {
  if (typeof m.content === "string") return clean(m.content)
  const c = m.content as Record<string, unknown> | null
  if (c && typeof c === "object") {
    const title = typeof c.name === "string" ? c.name : m.type || "attachment"
    if (typeof c.url === "string") return clean(`[${title}] ${c.url}`)
  }
  return clean(`[${m.type || "message"}] ${JSON.stringify(m.content) ?? ""}`)
}
