import { describe, expect, test } from "bun:test"
import { Store } from "../src/store"
import { demoClient } from "../src/demo"
import { controller } from "../src/control"

const first = "session_demo_1", second = "session_demo_2"
describe("shared human / agent state", () => {
  test("agent draft switches conversations but sends nothing; refuses overwrite", async () => {
    const store = new Store(demoClient())
    await store.refresh()
    const ctl = controller(store)
    const result = await ctl("draft", { session: second, text: "讓我協助你", note: true })
    expect(result).toMatchObject({ sent: false, session: second })
    expect(store.state.messages).toHaveLength(1)
    expect(store.draft()).toEqual({ text: "讓我協助你", note: true })
    await expect(ctl("draft", { session: second, text: "overwrite" })).rejects.toThrow("already exists")
    await ctl("draft", { session: second, text: "reviewed", replace: true })
    expect(store.draft()).toEqual({ text: "reviewed", note: false })
    await store.send()
    expect(store.state.messages.at(-1)?.content).toBe("reviewed")
    expect(store.draft().text).toBe("")
  })
  test("drafts and note mode survive navigation; failed sends preserve them", async () => {
    const client = demoClient()
    client.reply = async () => { throw new Error("rate limited") }
    const store = new Store(client)
    await store.refresh()
    store.setDraft("private", true)
    await store.open(second)
    store.setDraft("public")
    await store.open(first)
    expect(store.draft()).toEqual({ text: "private", note: true })
    await expect(store.send()).rejects.toThrow("rate limited")
    expect(store.draft().text).toBe("private")
    expect(store.state.sending).toBe(false)
  })
  test("write acknowledgement clears draft even if subsequent read fails", async () => {
    const client = demoClient()
    const store = new Store(client)
    await store.refresh()
    store.setDraft("sent once")
    client.messages = async () => { throw new Error("offline") }
    await store.send()
    expect(store.draft().text).toBe("")
    expect(store.state.error).toContain("Sent successfully")
  })
  test("late reads cannot replace a newly selected conversation", async () => {
    const client = demoClient()
    const get = client.get
    const wait = Promise.withResolvers<void>()
    client.get = async id => { if (id === first) await wait.promise; return get(id) }
    const store = new Store(client)
    const old = store.open(first)
    await store.open(second)
    wait.resolve()
    await old
    expect(store.state.active?.session_id).toBe(second)
    expect(store.state.messages[0]?.content).toContain("團隊")
  })
  test("overlapping search results keep the newest query", async () => {
    const client = demoClient(), list = client.list
    const wait = Promise.withResolvers<void>()
    client.list = async (page, query) => { if (query === "Customer A") await wait.promise; return list(page, query) }
    const store = new Store(client)
    const old = store.list("Customer A", 1)
    await store.list("Customer B", 1)
    wait.resolve(); await old
    expect(store.state.conversations[0]?.session_id).toBe(second)
    expect(store.state.query).toBe("Customer B")
  })
  test("reads don't mark read; explicit actions resolve, reopen and mark read", async () => {
    const store = new Store(demoClient())
    await store.refresh()
    expect(store.state.conversations[0]?.unread?.operator).toBe(1)
    await store.markRead()
    expect(store.state.conversations[0]?.unread?.operator).toBe(0)
    await store.changeState(); expect(store.state.active?.state).toBe("resolved")
    await store.changeState(); expect(store.state.active?.state).toBe("unresolved")
  })
  test("double submit does not send twice; navigation preserves another draft", async () => {
    const client = demoClient(), reply = client.reply
    const wait = Promise.withResolvers<void>()
    let count = 0
    client.reply = async (...args) => { count++; await wait.promise; return reply(...args) }
    const store = new Store(client)
    await store.refresh()
    await store.open(second); store.setDraft("second draft")
    await store.open(first); store.setDraft("first draft")
    const send = store.send()
    await store.send()
    await store.open(second)
    wait.resolve(); await send
    expect(count).toBe(1)
    expect(store.draft().text).toBe("second draft")
    expect(store.state.drafts[first]?.text).toBe("")
  })
  test("serialized agent drafts remain associated with their session", async () => {
    const store = new Store(demoClient()), ctl = controller(store)
    await Promise.all([ctl("draft", { session: first, text: "one" }), ctl("draft", { session: second, text: "two", note: true })])
    expect(store.state.drafts[first]?.text).toBe("one")
    expect(store.state.drafts[second]).toEqual({ text: "two", note: true })
    await expect(ctl("send", {})).rejects.toThrow("Unknown")
  })
  test("a poll started before sending cannot replace the acknowledged message history", async () => {
    const client = demoClient(), messages = client.messages
    const store = new Store(client)
    await store.refresh()
    const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    let delayed = false
    client.messages = async id => {
      const result = await messages(id)
      if (!delayed) { delayed = true; started.resolve(); await release.promise }
      return result
    }
    const poll = store.refresh()
    await started.promise
    store.setDraft("new reply")
    await store.send()
    release.resolve(); await poll
    expect(store.state.messages.at(-1)?.content).toBe("new reply")
  })
})
