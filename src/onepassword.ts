import { capture } from "./subprocess"
import { metrics } from "./performance"

export interface WebsiteCredentials { identifier: string; key: string; websiteId: string }

interface Item { fields?: { label?: string; value?: string }[] }
export function websiteCredentials(item: Item, override?: string): WebsiteCredentials {
  const field = (label: string) => item.fields?.find(f => f.label === label)?.value?.trim()
  const identifier = field("API Identifier"), key = field("API Key")
  const websiteId = override || field("website_id") || field("Website ID") || ""
  if (!identifier || !key) throw new Error("1Password item needs API Identifier and API Key fields")
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(websiteId)) throw new Error("Provide --website with the Crisp workspace UUID")
  return { identifier, key, websiteId }
}
export async function loadWebsiteCredentials(item: string, websiteId?: string, executable = "op", timeoutMs = 60_000) {
  return metrics.measure("startup.credentials", async () => {
    const { stdout, code, timedOut } = await capture([executable, "item", "get", item, "--format", "json"], timeoutMs)
    if (timedOut) throw new Error("1Password request timed out")
    if (code) throw new Error("1Password could not read the item. Unlock the desktop app and authorize op.")
    let itemData: Item
    try { itemData = JSON.parse(stdout) } catch { throw new Error("1Password returned invalid JSON") }
    return websiteCredentials(itemData, websiteId)
  })
}
