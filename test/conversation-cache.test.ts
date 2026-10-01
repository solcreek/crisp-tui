import { expect, test } from "bun:test"
import { ConversationCache } from "../src/conversation-cache"

test("conversation snapshots evict the least recently viewed entry", () => {
  const cache = new ConversationCache(2)
  cache.set({ session_id: "a" }, [])
  cache.set({ session_id: "b" }, [])
  expect(cache.get("a")?.active.session_id).toBe("a")
  cache.set({ session_id: "c" }, [])
  expect(cache.get("b")).toBeUndefined()
  expect(cache.get("a")).toBeDefined()
  expect(cache.get("c")).toBeDefined()
})

test("snapshot byte limits include UTF-8 and release replaced or deleted entries", () => {
  const active = { session_id: "a" }, messages = [{ content: "界" }]
  const bytes = Buffer.byteLength(JSON.stringify({ active, messages }))
  const cache = new ConversationCache(20, bytes * 2)
  cache.set(active, messages)
  cache.set({ session_id: "b" }, messages)
  cache.set(active, messages)
  expect(cache.get("b")).toBeDefined()
  cache.delete("b"); cache.delete("missing")
  cache.set({ session_id: "c" }, messages)
  expect(cache.get("a")).toBeDefined()
  cache.set({ session_id: "d" }, messages)
  expect(cache.get("c")).toBeUndefined()
  expect(cache.get("a")).toBeDefined()
  cache.set(active, [{ content: "界".repeat(bytes) }])
  expect(cache.get("a")).toBeUndefined()
  expect(cache.get("d")).toBeDefined()
})
