import { clean, type Conversation } from "./types"
import type { SidebarConfig } from "./layout"

export interface DetailRow { label: string; value: string; truncated: boolean }
export interface DetailGroup { title: string; rows: DetailRow[]; truncated: boolean }
function lookup(value: unknown, path: string[]): unknown {
  for (const key of path) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined
    value = (value as Record<string, unknown>)[key]
  }
  return value
}
function row(label: string, value: unknown): DetailRow {
  const text = clean(value === undefined || value === null || value === "" ? "—"
    : typeof value === "string" ? value : JSON.stringify(value)).replace(/[\r\n\t]/g, " ")
  const name = clean(label).replace(/[\r\n\t]/g, " ")
  return { label: name.length > 80 ? name.slice(0, 79) + "…" : name,
    value: text.length > 512 ? text.slice(0, 511) + "…" : text, truncated: text.length > 512 || name.length > 80 }
}
/** Project loaded conversation data only; opening a sidebar never triggers API requests. */
export function conversationDetails(active: Conversation | null, config: SidebarConfig): DetailGroup[] {
  if (!active) return []
  return config.sections.map(section => {
    if (section.fields) return { title: section.title, rows: section.fields.map(field => row(field.label, lookup(active, field.path))), truncated: false }
    const value = lookup(active, section.path)
    const entries = value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value) : []
    return { title: section.title, rows: entries.slice(0, 20).map(([key, value]) => row(key, value)), truncated: entries.length > 20 }
  })
}
