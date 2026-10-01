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
export async function loadWebsiteCredentials(item: string, websiteId?: string, executable = "op") {
  const child = Bun.spawn([executable, "item", "get", item, "--format", "json"], { env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => child.kill(), 60_000)
  try {
    const [out, , status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    if (status) throw new Error("1Password could not read the item. Unlock the desktop app and authorize op.")
    let itemData: Item
    try { itemData = JSON.parse(out) } catch { throw new Error("1Password returned invalid JSON") }
    return websiteCredentials(itemData, websiteId)
  } finally { clearTimeout(timer) }
}
