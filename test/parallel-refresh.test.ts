import { expect, test } from "bun:test"
import { Store } from "../src/store"
import { demoClient } from "../src/demo"
import { TestClock } from "./helpers/clock"

const first = "session_demo_1", second = "session_demo_2"

test("selected refresh publishes messages before a slow inbox and coalesces until both finish", async () => {
  const client = demoClient(), store = new Store(client), clock = new TestClock()
  await store.refresh()
  await client.reply(first, "New message", false)
  const list = client.list, release = Promise.withResolvers<void>()
  let lists = 0, finished = false
  client.list = async (...args) => { lists++; await release.promise; return list(...args) }
  const refresh = store.refresh()
  void refresh.then(() => { finished = true })
  await clock.flush()
  expect(store.state.messages.at(-1)?.content).toBe("New message")
  expect(store.state).toMatchObject({ loading: true, messagesLoading: false, detailsLoading: false })
  expect(finished).toBe(false)
  expect(store.refresh()).toBe(refresh)
  release.resolve(); await refresh
  expect(lists).toBe(1)
})

for (const failed of ["list", "messages"] as const) test(`${failed} failure drains the other branch and retains its successful data`, async () => {
  const client = demoClient(), store = new Store(client), clock = new TestClock()
  await store.refresh()
  await client.reply(first, "Remote update", false)
  const other = failed === "list" ? "messages" : "list"
  const original = client[other], release = Promise.withResolvers<void>()
  client[failed] = async () => { throw new Error(`${failed} offline`) }
  // Both methods have different argument types; wrap their own branch explicitly.
  if (other === "messages") {
    const messages = original as typeof client.messages
    client.messages = async id => { await release.promise; return messages(id) }
  } else {
    const list = original as typeof client.list
    client.list = async (...args) => { await release.promise; return list(...args) }
  }
  const refresh = store.refresh()
  const handled = store.perform(() => refresh)
  await clock.flush()
  expect(store.refresh()).toBe(refresh)
  expect(store.state.error).toBe("")
  release.resolve(); await handled
  expect(store.state.error).toBe(`${failed} offline`)
  expect(store.state).toMatchObject({ loading: false, messagesLoading: false, detailsLoading: false })
  if (failed === "list") expect(store.state.messages.at(-1)?.content).toBe("Remote update")
  else expect(store.state.conversations[0]?.last_message).toBe("Remote update")
})

test("independent refresh failures survive recovery of only the inbox", async () => {
  const client = demoClient(), store = new Store(client), list = client.list, messages = client.messages
  await store.refresh()
  client.list = async () => { throw new Error("inbox offline") }
  client.messages = async () => { throw new Error("history offline") }
  await store.perform(() => store.refresh())
  expect(store.state.error).toBe("inbox offline")
  client.list = list
  await store.list()
  expect(store.state.error).toBe("history offline")
  client.messages = messages
  await store.refresh()
  expect(store.state.error).toBe("")
})

test("late parallel responses preserve a newer search and conversation", async () => {
  const client = demoClient(), store = new Store(client), clock = new TestClock()
  await store.refresh()
  const list = client.list, get = client.get, messages = client.messages, release = Promise.withResolvers<void>()
  client.list = async (page, query) => { const value = await list(page, query); if (!query) await release.promise; return value }
  client.get = async id => { const value = await get(id); if (id === first) await release.promise; return value }
  client.messages = async id => { const value = await messages(id); if (id === first) await release.promise; return value }
  const refresh = store.refresh(); await clock.flush()
  await store.list("Customer B"); await store.open(second)
  release.resolve(); await refresh
  expect(store.state.query).toBe("Customer B")
  expect(store.state.conversations.map(c => c.session_id)).toEqual([second])
  expect(store.state.active?.session_id).toBe(second)
  expect(store.state.messages[0]?.content).toContain("teammates")
})

test("refresh does not duplicate a pending navigation's reads", async () => {
  const client = demoClient(), store = new Store(client), get = client.get
  await store.refresh()
  const release = Promise.withResolvers<void>()
  let gets = 0
  client.get = async id => { gets++; await release.promise; return get(id) }
  const opening = store.open(second)
  await store.refresh()
  expect(gets).toBe(1)
  expect(store.state.conversationLoading).toBe(true)
  release.resolve(); await opening
  expect(store.state.active?.session_id).toBe(second)
})
