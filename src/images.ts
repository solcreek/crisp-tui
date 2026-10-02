import { imageInfo, NativeImage } from "@opentui/core"
import type { Message } from "./types"

const hosts = new Set(["storage.crisp.chat", "image.crisp.chat"])
const formats = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"])
export const imageLimits = { bytes: 8 * 1024 * 1024, pixels: 16_000_000, cacheBytes: 16 * 1024 * 1024, cacheEntries: 32, edge: 1024 }

export function previewUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol === "https:" && hosts.has(url.hostname) && !url.username && !url.password && !url.port) return url.href
  } catch { /* Keep malformed/unsupported attachments as text. */ }
}

export function imageAttachment(message: Message): string | undefined {
  if (!["file", "animation"].includes(message.type ?? "")) return
  const content = message.content as Record<string, unknown> | null
  if (!content || typeof content !== "object" || typeof content.url !== "string") return
  const mime = typeof content.type === "string" ? content.type.toLowerCase().split(";")[0]!.trim() : ""
  const filename = typeof content.name === "string" ? content.name : ""
  if (mime ? !formats.has(mime) : !/\.(png|jpe?g|webp|gif)$/i.test(filename)) return
  return previewUrl(content.url)
}

type FetchImage = (url: string, init: RequestInit) => Promise<Response>

/** Session-only, bounded cache. No credentials, cookies, disk files or API writes. */
export class ImagePreviews {
  private cache = new Map<string, Uint8Array>()
  private bytes = 0
  private active = 0
  private queue: (() => void)[] = []
  private stopped = new AbortController()
  constructor(private request: FetchImage = fetch, private timeoutMs = 12_000) {}

  dispose() { this.stopped.abort(); this.cache.clear(); this.bytes = 0 }

  private async slot(signal: AbortSignal) {
    signal.throwIfAborted()
    if (this.active < 2) { this.active++; return }
    await new Promise<void>((resolve, reject) => {
      const start = () => { signal.removeEventListener("abort", abort); this.active++; resolve() }
      const abort = () => { this.queue = this.queue.filter(item => item !== start); reject(signal.reason) }
      this.queue.push(start)
      signal.addEventListener("abort", abort, { once: true })
    })
  }

  async load(value: string, caller: AbortSignal): Promise<NativeImage> {
    const url = previewUrl(value)
    if (!url) throw new Error("Unsupported image host")
    const signal = AbortSignal.any([caller, this.stopped.signal, AbortSignal.timeout(this.timeoutMs)])
    await this.slot(signal)
    try {
      signal.throwIfAborted()
      let bytes = this.cache.get(url)
      if (!bytes) bytes = await this.download(url, signal)
      signal.throwIfAborted()
      const info = imageInfo(bytes)
      if (info.width * info.height > imageLimits.pixels) throw new Error("Image dimensions exceed preview limit")
      const original = NativeImage.decode(bytes)
      let preview: NativeImage
      try {
        const scale = Math.min(1, imageLimits.edge / Math.max(original.width, original.height))
        preview = scale === 1 ? original.retain() : original.resize({
          width: Math.max(1, Math.round(original.width * scale)), height: Math.max(1, Math.round(original.height * scale)),
        })
      } finally { original.dispose() }
      this.cache.delete(url)
      // Recompute instead of maintaining counts across cache hits/replacements.
      this.cache.set(url, bytes)
      this.bytes = [...this.cache.values()].reduce((sum, item) => sum + item.byteLength, 0)
      while (this.bytes > imageLimits.cacheBytes || this.cache.size > imageLimits.cacheEntries) {
        const oldest = this.cache.keys().next().value!
        this.bytes -= this.cache.get(oldest)!.byteLength
        this.cache.delete(oldest)
      }
      return preview
    } finally { this.active--; this.queue.shift()?.() }
  }

  private async download(initial: string, signal: AbortSignal) {
    let url = initial
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await this.request(url, {
        method: "GET", credentials: "omit", referrerPolicy: "no-referrer", redirect: "manual", signal,
        headers: { Accept: "image/png,image/jpeg,image/webp,image/gif" },
      })
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel()
        const location = response.headers.get("location")
        const next = location && previewUrl(new URL(location, url).href)
        if (!next) throw new Error("Unsupported image redirect")
        url = next
        continue
      }
      if (!response.ok || !response.body || Number(response.headers.get("content-length")) > imageLimits.bytes) {
        await response.body?.cancel()
        throw new Error("Image unavailable or too large")
      }
      const reader = response.body.getReader(), chunks: Uint8Array[] = []
      let total = 0
      const abort = () => { void reader.cancel().catch(() => {}) }
      signal.addEventListener("abort", abort, { once: true })
      try {
        signal.throwIfAborted()
        while (true) {
          const { done, value } = await reader.read()
          signal.throwIfAborted()
          if (done) break
          total += value.byteLength
          if (total > imageLimits.bytes) throw new Error("Image exceeds preview limit")
          chunks.push(value)
        }
        return new Uint8Array(Buffer.concat(chunks, total))
      } finally {
        signal.removeEventListener("abort", abort)
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
    }
    throw new Error("Too many image redirects")
  }
}
