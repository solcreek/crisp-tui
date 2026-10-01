import { describe, expect, test } from "bun:test"
import { Store } from "../src/store"
import { demoClient } from "../src/demo"
import { controller } from "../src/control"

const first = "session_demo_1", second = "session_demo_2"
test("revisiting a conversation displays its snapshot before revalidation completes", async () => {
  const client = demoClient(), store = new Store(client)
  await store.refresh(); store.setDraft("Keep draft")
  await store.open(second)
  await client.reply(first, "New remote message", false)
  const get = client.get, wait = Promise.withResolvers<void>()
  let gets = 0
  client.get = async id => { gets++; await wait.promise; return get(id) }
  const opening = store.open(first)
  const duplicate = store.open(first)
  expect(duplicate).toBe(opening)
  expect(store.state.active?.session_id).toBe(first)
  expect(store.state.messages).toHaveLength(1)
  expect(store.state.conversationLoading).toBe(true)
  expect(store.state.conversationCached).toBe(true)
  expect(await controller(store)("state", {})).toMatchObject({ conversationCached: true, conversationLoading: true })
  expect(store.state.status).toContain("Showing saved conversation")
  expect(store.draft().text).toBe("Keep draft")
  wait.resolve(); await opening
  expect(gets).toBe(1)
  expect(store.state.messages.at(-1)?.content).toBe("New remote message")
  expect(store.state.conversationLoading).toBe(false)
  expect(store.state.conversationCached).toBe(false)
})

test("sending while a cached conversation revalidates cannot restore the pre-send response", async () => {
  const client = demoClient(), store = new Store(client), messages = client.messages
  await store.refresh(); await store.open(second)
  const started = Promise.withResolvers<void>(), wait = Promise.withResolvers<void>()
  let calls = 0
  client.messages = async id => {
    const value = await messages(id)
    if (++calls === 1) { started.resolve(); await wait.promise }
    return value
  }
  const opening = store.open(first)
  await started.promise
  store.setDraft("Sent while updating")
  await store.send()
  expect(store.state.status).toBe("Reply sent")
  expect(store.state.messages.at(-1)?.content).toBe("Sent while updating")
  wait.resolve(); await opening
  expect(store.state.messages.at(-1)?.content).toBe("Sent while updating")
  expect(store.draft().text).toBe("")
})

test("failed revalidation retains the matching snapshot and refresh recovers", async () => {
  const client = demoClient(), store = new Store(client), get = client.get
  await store.refresh(); await store.open(second)
  client.get = async () => { throw new Error("offline") }
  await store.perform(() => store.open(first))
  expect(store.state.active?.session_id).toBe(first)
  expect(store.state.messages).toHaveLength(1)
  expect(store.state.error).toBe("offline")
  expect(store.state.status).toContain("Showing saved conversation; update failed")
  expect(store.state.conversationCached).toBe(true)
  client.get = get
  await client.reply(first, "Recovered message", false)
  await store.refresh()
  expect(store.state.error).toBe("")
  expect(store.state.conversationCached).toBe(false)
  expect(store.state.status).not.toContain("failed")
  expect(store.state.messages.at(-1)?.content).toBe("Recovered message")
})

test("an obsolete warm navigation cannot overwrite another cached selection", async () => {
  const client = demoClient(), store = new Store(client), get = client.get
  await store.refresh(); await store.open(second)
  const wait = Promise.withResolvers<void>()
  client.get = async id => { if (id === first) await wait.promise; return get(id) }
  const old = store.open(first)
  expect(store.state.active?.session_id).toBe(first)
  await store.open(second)
  wait.resolve(); await old
  expect(store.state.active?.session_id).toBe(second)
  expect(store.state.messages[0]?.content).toContain("teammates")
})

for (const action of ["changeState", "markRead", "send"] as const) test(`acknowledged ${action} cannot restore a pre-write snapshot`, async () => {
  const client = demoClient(), store = new Store(client), get = client.get, messages = client.messages
  await store.refresh(); store.setDraft("New reply")
  if (action === "send") client.messages = async () => { throw new Error("follow-up read failed") }
  await store[action]()
  // Keep the failed send refresh from interfering with navigation to another session.
  client.messages = messages
  await store.open(second)
  const wait = Promise.withResolvers<void>()
  client.get = async id => { await wait.promise; return get(id) }
  const opening = store.open(first)
  expect(store.state.active).toBeNull()
  expect(store.state.messages).toEqual([])
  wait.resolve(); await opening
})

describe("shared human / agent state", () => {
  test("agent draft switches conversations but sends nothing; refuses overwrite", async () => {
    const store = new Store(demoClient())
    await store.refresh()
    const ctl = controller(store)
    const result = await ctl("draft", { session: second, text: "Let me help you with that.", note: true })
    expect(result).toMatchObject({ sent: false, session: second })
    expect(store.state.messages).toHaveLength(1)
    expect(store.draft()).toEqual({ text: "Let me help you with that.", note: true })
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
    expect(store.state.messages[0]?.content).toContain("teammates")
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

test("first refresh reads a conversation only once", async () => {
  const client = demoClient(), calls: string[] = []
  const list = client.list, get = client.get, messages = client.messages
  client.list = (...args) => { calls.push("list"); return list(...args) }
  client.get = id => { calls.push("get"); return get(id) }
  client.messages = id => { calls.push("messages"); return messages(id) }
  await new Store(client).refresh()
  expect(calls).toEqual(["list", "get", "messages"])
})

test("a list arriving during navigation preserves the selected conversation", async () => {
  const client = demoClient(), list = client.list, get = client.get
  const listed = Promise.withResolvers<void>(), releaseList = Promise.withResolvers<void>()
  const opened = Promise.withResolvers<void>(), releaseOpen = Promise.withResolvers<void>()
  client.list = async (...args) => { const rows = await list(...args); listed.resolve(); await releaseList.promise; return rows }
  client.get = async id => { if (id === second) { opened.resolve(); await releaseOpen.promise }; return get(id) }
  const store = new Store(client), refreshing = store.refresh()
  await listed.promise
  const opening = store.open(second)
  await opened.promise
  expect(store.state).toMatchObject({ selectedSession: second, conversationLoading: true })
  releaseList.resolve(); await refreshing
  expect(store.state.selectedSession).toBe(second)
  releaseOpen.resolve(); await opening
  expect(store.state.active?.session_id).toBe(second)
  expect(store.state.conversationLoading).toBe(false)
})

for (const action of ["resolve", "read"] as const) test(`a list requested before ${action} cannot restore stale data`, async () => {
  const client = demoClient(), store = new Store(client)
  await store.refresh()
  const list = client.list, started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let reads = 0
  client.list = async (...args) => {
    const rows = await list(...args)
    if (++reads === 1) { started.resolve(); await release.promise }
    return rows
  }
  const refreshing = store.refresh()
  await started.promise
  if (action === "resolve") await store.changeState()
  else await store.markRead()
  release.resolve(); await refreshing
  expect(reads).toBe(2)
  const row = store.state.conversations.find(c => c.session_id === first)!
  if (action === "resolve") {
    expect(row.state).toBe("resolved")
    expect(store.state.active?.state).toBe("resolved")
  } else {
    expect(row.unread?.operator).toBe(0)
    expect(store.state.active?.unread?.operator).toBe(0)
  }
})

test("a superseded navigation failure cannot overwrite the current status", async () => {
  const client = demoClient(), get = client.get, release = Promise.withResolvers<void>()
  client.get = async id => { if (id === first) { await release.promise; throw new Error("old failure") }; return get(id) }
  const store = new Store(client), old = store.perform(() => store.open(first))
  await store.open(second)
  release.resolve(); await old
  expect(store.state.active?.session_id).toBe(second)
  expect(store.state.error).toBe("")
  expect(store.state.conversationLoading).toBe(false)
})

test("a failed obsolete search cannot overwrite a newer search's state", async () => {
  const client = demoClient(), store = new Store(client)
  await store.refresh()
  const list = client.list, old = Promise.withResolvers<never>()
  client.list = (page, query) => query === "old" ? old.promise : list(page, query)
  const previous = store.perform(() => store.list("old"))
  await store.list("Customer B")
  old.reject(new Error("obsolete failure")); await previous
  expect(store.state.query).toBe("Customer B")
  expect(store.state.conversations.map(c => c.session_id)).toEqual(["session_demo_2"])
  expect(store.state.error).toBe("")
  expect(store.state.loading).toBe(false)
  client.list = async () => { throw new Error("current failure") }
  await store.perform(() => store.list("current"))
  expect(store.state.error).toBe("current failure")
})

for (const initial of [true, false]) test(`refresh retries a failed ${initial ? "initial" : "navigated"} conversation without losing drafts`, async () => {
  const client = demoClient(), store = new Store(client), get = client.get
  if (!initial) { await store.refresh(); store.setDraft("keep first draft") }
  let calls = 0
  client.get = async id => { if (++calls === 1) throw new Error("temporary failure"); return get(id) }
  await store.perform(() => initial ? store.refresh() : store.open(second))
  expect(store.state.active).toBeNull()
  expect(store.state.error).toBe("temporary failure")
  expect(store.state.conversationLoading).toBe(false)
  expect(store.state.status).not.toBe("Loading conversation…")
  await store.refresh()
  expect(calls).toBe(2)
  expect(store.state.active?.session_id).toBe(initial ? first : second)
  expect(store.state.error).toBe("")
  if (!initial) expect(store.state.drafts[first]?.text).toBe("keep first draft")
})

test("repeated recovery failures remain visible and do not switch to the first conversation", async () => {
  const client = demoClient(), store = new Store(client)
  await store.refresh()
  client.get = async () => { throw new Error("still offline") }
  await store.perform(() => store.open(second))
  await store.perform(() => store.refresh())
  expect(store.state.selectedSession).toBe(second)
  expect(store.state.active).toBeNull()
  expect(store.state.error).toBe("still offline")
})

test("a failed background message read cannot report an error on a newly selected conversation", async () => {
  const client = demoClient(), store = new Store(client), messages = client.messages
  await store.refresh()
  const old = Promise.withResolvers<never>(), started = Promise.withResolvers<void>()
  client.messages = id => { if (id === first) { started.resolve(); return old.promise }; return messages(id) }
  const poll = store.perform(() => store.refresh())
  await started.promise; await store.open(second)
  old.reject(new Error("obsolete failure")); await poll
  expect(store.state.active?.session_id).toBe(second)
  expect(store.state.error).toBe("")
})

for (const fails of [false, true]) test(`an older poll ${fails ? "failure" : "success"} preserves a newer send failure`, async () => {
  const client = demoClient(), store = new Store(client), messages = client.messages
  await store.refresh()
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  client.messages = async id => { started.resolve(); await release.promise; if (fails) throw new Error("old poll failed"); return messages(id) }
  const poll = store.perform(() => store.refresh())
  await started.promise
  store.setDraft("unsent")
  client.reply = async () => { throw new Error("send failed") }
  await store.perform(() => store.send())
  release.resolve(); await poll
  expect(store.state.error).toBe("send failed")
  expect(store.state.errorSource).toBe("send")
  expect(store.draft().text).toBe("unsent")
  client.messages = messages
  await store.refresh()
  expect(store.state.error).toBe("send failed")
  client.reply = async () => {}
  await store.send()
  expect(store.state.error).toBe("")
})

test("RTM recovery clears only its own error", async () => {
  const client = demoClient(), store = new Store(client)
  await store.refresh()
  store.setRealtime({ state: "error", message: "RTM offline" })
  await store.refresh()
  expect(store.state.error).toBe("RTM offline")
  store.setRealtime({ state: "authenticated" })
  expect(store.state.error).toBe("")
  store.setDraft("unsent")
  client.reply = async () => { throw new Error("send failed") }
  await store.perform(() => store.send())
  store.setRealtime({ state: "authenticated" })
  expect(store.state.error).toBe("send failed")
})

test("background diagnostics cannot hide a pending send failure and recover independently", async () => {
  const client = demoClient(), store = new Store(client)
  await store.refresh(); store.setDraft("unsent")
  const release = Promise.withResolvers<void>()
  client.reply = async () => { await release.promise; throw new Error("send failed") }
  const sending = store.perform(() => store.send())
  store.setRealtime({ state: "error", message: "RTM offline" })
  release.resolve(); await sending
  expect(store.state.error).toBe("send failed")
  client.list = async () => { throw new Error("list offline") }
  await store.perform(() => store.refresh())
  expect(store.state.error).toBe("send failed")
  store.setRealtime({ state: "authenticated" })
  expect(store.state.error).toBe("send failed")
  client.reply = async () => {}
  await store.send()
  expect(store.state.error).toBe("list offline")
  client.list = demoClient().list
  await store.refresh()
  expect(store.state.error).toBe("")
})

for (const kind of ["state", "read"] as const) test(`${kind} failures survive refresh and clear after the matching action succeeds`, async () => {
  const client = demoClient(), store = new Store(client)
  await store.refresh()
  const action = () => kind === "state" ? store.changeState() : store.markRead()
  client[kind] = async () => { throw new Error(`${kind} failed`) }
  await store.perform(action); await store.refresh()
  expect(store.state.errorSource).toBe(kind)
  client[kind] = async () => {}
  await action()
  expect(store.state.error).toBe("")
})
