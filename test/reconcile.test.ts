import { expect, test } from "bun:test"
import { reuseRecords } from "../src/reconcile"
import { demoClient } from "../src/demo"
import { Store } from "../src/store"

test("unchanged refresh preserves list, conversation metadata and message references", async () => {
  const client = demoClient(), store = new Store(client)
  await store.refresh()
  const { active, messages, conversations } = store.state
  await store.refresh()
  expect(store.state.active).toBe(active)
  expect(store.state.messages).toBe(messages)
  expect(store.state.conversations).toBe(conversations)
  await client.reply(active!.session_id, "A new message", false)
  await store.refresh()
  expect(store.state.messages).not.toBe(messages)
  expect(store.state.messages[0]).toBe(messages[0])
  expect(store.state.messages.at(-1)?.content).toBe("A new message")
})

test("changed, removed and reordered messages retain only genuinely unchanged records", () => {
  const old = [{ fingerprint: 1, content: { text: "one" } }, { fingerprint: 2, content: { text: "two" } }]
  const key = (message: typeof old[number]) => message.fingerprint
  const reordered = reuseRecords(old, structuredClone(old).reverse(), key)
  expect(reordered[0]).toBe(old[1]); expect(reordered[1]).toBe(old[0])
  const updated = reuseRecords(old, [{ fingerprint: 2, content: { text: "edited" } }], key)
  expect(updated).toHaveLength(1)
  expect(updated[0]).not.toBe(old[1])
  expect(updated[0]?.content.text).toBe("edited")
})

test("missing or duplicate fingerprints never alias independent renderables", () => {
  const old = [{ content: "a" }, { content: "b" }]
  expect(reuseRecords(old, structuredClone(old), () => undefined)).toBe(old)
  const duplicates = [{ id: 1, content: "a" }, { id: 1, content: "a" }]
  const next = reuseRecords(duplicates, structuredClone(duplicates), message => message.id)
  expect(next[0]).not.toBe(next[1])
  const repeated = reuseRecords([duplicates[0]!], structuredClone(duplicates), message => message.id)
  expect(repeated[0]).toBe(duplicates[0])
  expect(repeated[1]).not.toBe(repeated[0])
})
