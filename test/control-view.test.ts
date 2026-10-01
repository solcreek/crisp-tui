import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { controller, request, serve } from "../src/control"
import { controlPage, controlRead, controlScreen, controlState } from "../src/control-view"
import { parseControlCommand, validateCommand } from "../src/commands"
import { Store } from "../src/store"
import { demoClient } from "../src/demo"

const first = "session_demo_1"
test("large histories and accumulated drafts keep state, goto and refresh responses small", async () => {
  const client = demoClient(), store = new Store(client)
  await store.refresh()
  const dir = await mkdtemp("/tmp/crisp-view-"), path = `${dir}/s`
  const server = await serve(path, controller(store))
  try {
    for (const session of [first, "session_demo_2", "session_demo_3"]) {
      expect(await request(path, "draft", { session, text: "x".repeat(360_000) })).toMatchObject({ sent: false, draft: { length: 360_000 } })
    }
    client.messages = async () => [{ content: "中".repeat(600_000) }]
    for (const [method, params] of [["state", {}], ["goto", { session: first }], ["refresh", {}]] as const) {
      const result = await request(path, method, params)
      expect(result).toMatchObject({ protocol: 2, counts: { drafts: 3 }, draft: { length: 360_000 } })
      expect(result).not.toHaveProperty("messages")
      expect(result).not.toHaveProperty("drafts")
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(4096)
    }
    const page = await request(path, "messages")
    expect(page).toMatchObject({ total: 1, nextOffset: null, items: [{ index: 0, previewTruncated: true }] })
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(10_000)
    expect(await request(path, "drafts", { limit: 1 })).toMatchObject({ total: 3, nextOffset: 1, items: [{ session: first, length: 360_000 }] })
    const state = store.state
    let text = "", offset: number | null = 0
    while (offset !== null) {
      const chunk = await request(path, "read", { resource: "drafts", key: first, offset, revision: state.revision }) as ReturnType<typeof controlRead>
      text += chunk.text; offset = chunk.nextOffset
      expect(Buffer.byteLength(JSON.stringify(chunk))).toBeLessThan(100_000)
    }
    expect(JSON.parse(text)).toEqual({ text: "x".repeat(360_000), note: false })
    expect(store.state).toBe(state)
  } finally { await server.stop(); await rm(dir, { recursive: true, force: true }) }
})

test("pages expose stable offsets and reject stale revisions without doing API work", async () => {
  const store = new Store(demoClient())
  await store.refresh()
  const revision = store.state.revision
  const page = controlPage(store, "conversations", { limit: 2, revision })
  expect(page).toMatchObject({ total: 3, offset: 0, nextOffset: 2 })
  expect(controlPage(store, "conversations", { offset: page.nextOffset!, limit: 2, revision })).toMatchObject({ nextOffset: null, items: [{ session_id: "session_demo_3" }] })
  expect(controlPage(store, "messages", { offset: 100 })).toMatchObject({ items: [], nextOffset: null })
  store.setDraft("changed")
  expect(() => controlPage(store, "messages", { revision })).toThrow("State changed")
  expect(() => controlRead(store, "drafts", first, { revision })).toThrow("State changed")
  expect(() => controlPage(store, "messages", { limit: 101 })).toThrow("at most 100")
})

test("chunked JSON reconstructs Unicode, attachments and drafts exactly", async () => {
  const store = new Store(demoClient())
  await store.refresh()
  const message = { type: "file", content: { name: "中🙂", url: "https://example.com/\"file\"", extra: "\n\t" } }
  store.update({ messages: [message] }); store.setDraft("🙂中\n\"text\"")
  for (const [resource, key, original] of [["messages", "0", message], ["conversations", "0", store.state.conversations[0]], ["drafts", first, store.draft()]] as const) {
    let text = "", offset: number | null = 0
    while (offset !== null) {
      const chunk = controlRead(store, resource, key, { offset, limit: 1, revision: store.state.revision })
      text += chunk.text; offset = chunk.nextOffset
    }
    expect(JSON.parse(text)).toEqual(original)
  }
  expect(controlRead(store, "messages", "0", { offset: 100_000 })).toMatchObject({ text: "", nextOffset: null })
  for (const [resource, key] of [["invalid", "0"], ["messages", "-1"], ["messages", "1e2"], ["messages", "999"], ["drafts", "__proto__"]]) {
    expect(() => controlRead(store, resource!, key!, {})).toThrow()
  }
  expect(() => controlRead(store, "messages", "0", { limit: 16_385 })).toThrow("at most 16384")
})

test("CLI and socket pagination parameters share strict bounds", () => {
  expect(parseControlCommand("read", ["drafts", first], { offset: "0", limit: "100", revision: "42" }).params)
    .toEqual({ resource: "drafts", key: first, offset: 0, limit: 100, revision: 42 })
  for (const value of ["-1", "1.2", "", "Infinity", "9007199254740992"]) {
    expect(() => parseControlCommand("messages", [], { offset: value })).toThrow()
  }
  for (const params of [{ offset: -1 }, { limit: 0 }, { revision: 1.5 }, { limit: "10" }]) {
    expect(() => validateCommand("messages", params)).toThrow()
  }
  expect(() => parseControlCommand("state", [], { limit: "10" })).toThrow("Unknown")
})

test("previews and screen mark truncation and keep state free of internal fields", async () => {
  const store = new Store(demoClient())
  expect(controlState(store)).toMatchObject({ active: null, draft: { length: 0 }, textTruncated: false })
  await store.refresh()
  store.update({ query: "q".repeat(2000), messages: [{ content: "m".repeat(100_000) }] })
  expect(controlState(store)).toMatchObject({ textTruncated: true })
  expect(controlScreen(store)).toContain("[Screen truncated;")
  expect(controlScreen(store).length).toBeLessThanOrEqual(65_536)
})

test("byte-limited pages advance without skipping records and oversized records remain readable", async () => {
  const store = new Store(demoClient())
  await store.refresh()
  store.update({ messages: Array.from({ length: 100 }, (_, fingerprint) => ({ fingerprint, content: "中".repeat(2048), user: { nickname: "中".repeat(512) } })) })
  let offset: number | null = 0
  const indices: number[] = []
  while (offset !== null) {
    const page = controlPage(store, "messages", { offset, limit: 100 })
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(530_000)
    if (offset === 0) expect(page.items.length).toBeLessThan(100)
    indices.push(...page.items.map(item => (item as { index: number }).index))
    offset = page.nextOffset
  }
  expect(indices).toEqual(Array.from({ length: 100 }, (_, i) => i))
  store.update({ messages: [{ content: "text", fingerprint: "f".repeat(600_000) }] })
  expect(() => controlPage(store, "messages", {})).toThrow("use ctl read")
  expect(controlRead(store, "messages", "0", {})).toMatchObject({ nextOffset: 16_384 })
})

test("server rejects an oversized response with a bounded actionable error", async () => {
  const dir = await mkdtemp("/tmp/crisp-large-response-"), path = `${dir}/s`
  const server = await serve(path, () => "x".repeat(1_048_576))
  try { await expect(request(path, "state")).rejects.toThrow("use smaller pages or ctl read") }
  finally { await server.stop(); await rm(dir, { recursive: true, force: true }) }
})


test("screen cap includes its complete notice and leaves inputs at or below the limit unchanged", () => {
  const store = new Store(demoClient())
  store.update({ messages: [{ content: "" }] })
  const overhead = store.screen().length
  for (const length of [65_535, 65_536, 65_537]) {
    store.update({ messages: [{ content: "x".repeat(length - overhead) }] })
    const original = store.screen(), result = controlScreen(store)
    expect(original.length).toBe(length)
    expect(result.length).toBeLessThanOrEqual(65_536)
    if (length <= 65_536) expect(result).toBe(original)
    else {
      expect(result.length).toBe(65_536)
      expect(result).toEndWith("\n[Screen truncated; use ctl messages/conversations/drafts and ctl read.]")
    }
  }
})
