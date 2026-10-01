import { homedir } from "node:os"
import { join } from "node:path"

export interface DetailField { label: string; path: string[] }
export type DetailSection = { title: string; fields: DetailField[]; path?: never } | { title: string; path: string[]; fields?: never }
export interface SidebarConfig { enabled: boolean; width: number; sections: DetailSection[] }
export interface LayoutConfig { sidebar: SidebarConfig }
export const defaultLayout: LayoutConfig = { sidebar: { enabled: true, width: 36, sections: [
  { title: "Contact", fields: [
    { label: "Name", path: ["meta", "nickname"] }, { label: "Email", path: ["meta", "email"] },
    { label: "Phone", path: ["meta", "phone"] }, { label: "Segments", path: ["meta", "segments"] },
  ] },
  { title: "Visitor", fields: [
    { label: "City", path: ["meta", "device", "geolocation", "city"] },
    { label: "Country", path: ["meta", "device", "geolocation", "country"] },
    { label: "Browser", path: ["meta", "device", "system", "browser", "name"] },
    { label: "OS", path: ["meta", "device", "system", "os", "name"] },
    { label: "Languages", path: ["meta", "device", "locales"] },
  ] },
  { title: "Custom data", path: ["meta", "data"] },
] } }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value) }
function keys(value: unknown, allowed: string[], name: string): asserts value is Record<string, unknown> {
  if (!record(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`Invalid ${name} settings`)
}
function title(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 80 || /[\x00-\x1f\x7f-\x9f]/.test(value)) throw new Error("Titles and labels must be 1–80 printable characters")
  return value
}
function path(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 12 || value.some(key => typeof key !== "string" || !key || key.length > 128 || ["__proto__", "prototype", "constructor"].includes(key))) throw new Error("Field paths must contain 1–12 safe object keys")
  return [...value]
}
export function parseLayout(value: unknown): LayoutConfig {
  keys(value, ["sidebar"], "layout")
  const sidebar = value.sidebar === undefined ? {} : value.sidebar
  keys(sidebar, ["enabled", "width", "sections"], "sidebar")
  if (sidebar.enabled !== undefined && typeof sidebar.enabled !== "boolean") throw new Error("Sidebar enabled must be boolean")
  if (sidebar.width !== undefined && (!Number.isInteger(sidebar.width) || Number(sidebar.width) < 24 || Number(sidebar.width) > 60)) throw new Error("Sidebar width must be 24–60 columns")
  let sections = structuredClone(defaultLayout.sidebar.sections)
  if (sidebar.sections !== undefined) {
    if (!Array.isArray(sidebar.sections) || sidebar.sections.length > 8) throw new Error("Sidebar supports at most 8 sections")
    sections = sidebar.sections.map(section => {
      keys(section, ["title", "fields", "path"], "section")
      const name = title(section.title)
      if (section.path !== undefined) {
        if (section.fields !== undefined) throw new Error("A section must use fields or path, not both")
        return { title: name, path: path(section.path) }
      }
      if (!Array.isArray(section.fields) || section.fields.length > 20) throw new Error("A section supports at most 20 fields")
      return { title: name, fields: section.fields.map(field => {
        keys(field, ["label", "path"], "field")
        return { label: title(field.label), path: path(field.path) }
      }) }
    })
  }
  return { sidebar: { enabled: sidebar.enabled ?? true, width: sidebar.width ?? 36, sections } } as LayoutConfig
}
export async function loadLayout(file?: string, env = process.env): Promise<LayoutConfig> {
  const explicit = file ?? env.CRISP_TUI_CONFIG
  const location = explicit ?? join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config"), "crisp-tui", "config.json")
  let bytes: ArrayBuffer
  // Read one byte beyond the limit to detect overflow without loading the whole file.
  try { bytes = await Bun.file(location).slice(0, 65_537).arrayBuffer() }
  catch (error) {
    if (!explicit && (error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(defaultLayout)
    throw new Error(`Cannot read TUI configuration: ${location}`)
  }
  if (bytes.byteLength > 65_536) throw new Error("TUI configuration exceeds 64 KiB")
  const text = new TextDecoder().decode(bytes)
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error("TUI configuration must be valid JSON") }
  return parseLayout(value)
}
