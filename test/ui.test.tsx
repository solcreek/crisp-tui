import { afterEach, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { App } from "../src/ui/App"
import { demoClient } from "../src/demo"
import { Store } from "../src/store"
import { controller } from "../src/control"
import { readOnlyClient } from "../src/readonly"

let ui: Awaited<ReturnType<typeof testRender>> | undefined
afterEach(() => { ui?.renderer.destroy(); ui = undefined })
async function frame(...texts: string[]) {
  let value = ""
  for (let i = 0; i < 50; i++) {
    await Bun.sleep(20); await ui!.renderOnce(); value = ui!.captureCharFrame()
    if (texts.every(text => value.includes(text))) return value
  }
  for (const text of texts) expect(value).toContain(text)
  return value
}
test("inbox renders; agent draft is visible and Enter saves an internal note", async () => {
  const store = new Store(demoClient())
  await store.refresh()
  let focus = () => {}
  ui = await testRender(() => <App store={store} bindFocus={fn => { focus = fn }} />, { width: 110, height: 32 })
  await frame("Demo Customer A", "invoice", "DEMO")
  await controller(store, () => focus())("draft", { session: "session_demo_2", text: "Checking invitation settings", note: true })
  await frame("Checking invitation settings", "Internal note")
  expect(store.state.messages).toHaveLength(1)
  ui.mockInput.pressEnter()
  await frame("INTERNAL NOTE", "Internal note saved")
  expect(store.state.messages.at(-1)?.type).toBe("note")
  expect(store.draft().text).toBe("")
})
test("typing, navigation, and failed sends preserve composer text", async () => {
  const client = demoClient()
  client.reply = async () => { throw new Error("offline: draft kept") }
  const store = new Store(client)
  await store.refresh()
  ui = await testRender(() => <App store={store} />, { width: 80, height: 24 })
  await frame("Demo Customer A")
  ui.mockInput.pressKey("TAB"); ui.mockInput.pressKey("TAB")
  await Bun.sleep(30)
  await ui.mockInput.typeText("Please keep my reply")
  ui.mockInput.pressEnter()
  await frame("offline: draft kept", "Please keep my reply")
  expect(store.draft().text).toBe("Please keep my reply")
})
test("read-only UI hides composer and blocks mutation shortcuts", async () => {
  const client = demoClient()
  let writes = 0
  client.reply = client.state = client.read = async () => { writes++ }
  const store = new Store(readOnlyClient(client))
  await store.refresh()
  ui = await testRender(() => <App store={store} />, { width: 100, height: 28 })
  const initial = await frame("READ ONLY", "sending and conversation changes disabled")
  expect(initial).not.toContain("Enter to send")
  ui.mockInput.pressKey("e", { ctrl: true })
  await frame("Read-only mode")
  ui.mockInput.pressKey("u", { ctrl: true })
  ui.mockInput.pressKey("TAB"); ui.mockInput.pressEnter()
  await frame("READ ONLY")
  expect(writes).toBe(0)
  expect(store.state.messages).toHaveLength(1)
})

test("empty-page navigation keeps a valid cursor when returning to the inbox", async () => {
  const store = new Store(demoClient())
  await store.refresh()
  ui = await testRender(() => <App store={store} />, { width: 100, height: 28 })
  await frame("Demo Customer A")
  ui.mockInput.pressArrow("down"); ui.mockInput.pressEnter()
  await frame("Opened Demo Customer B")
  expect(store.state.active?.session_id).toBe("session_demo_2")
  ui.mockInput.pressEscape()
  // Standalone Escape must settle before ']' can be interpreted as another key.
  await Bun.sleep(50)
  ui.mockInput.pressKey("]")
  await frame("No conversations on this page.")
  ui.mockInput.pressArrow("down")
  ui.mockInput.pressKey("[")
  await frame("INBOX · page 1", "Demo Customer A")
  ui.mockInput.pressEnter()
  await frame("Opened Demo Customer A")
  expect(store.state.active?.session_id).toBe("session_demo_1")
})

test("keyboard search resets pagination and preserves an existing draft", async () => {
  const store = new Store(demoClient())
  await store.refresh()
  store.setDraft("Keep this reply")
  ui = await testRender(() => <App store={store} />, { width: 100, height: 28 })
  await frame("Keep this reply")
  ui.mockInput.pressKey("]")
  await frame("INBOX · page 2")
  ui.mockInput.pressKey("/")
  await frame("Search · Enter to submit")
  await ui.mockInput.typeText("onboarding")
  ui.mockInput.pressEnter()
  await frame("INBOX · page 1", "Search: onboarding")
  expect(store.state.conversations.map(c => c.session_id)).toEqual(["session_demo_2"])
  expect(store.state.drafts.session_demo_1?.text).toBe("Keep this reply")
})

test("keyboard note, state, read and refresh shortcuts operate on the active conversation", async () => {
  const client = demoClient(), store = new Store(client)
  await store.refresh()
  store.setDraft("Saved draft")
  ui = await testRender(() => <App store={store} />, { width: 100, height: 28 })
  await frame("Saved draft")
  ui.mockInput.pressKey("n", { ctrl: true })
  await frame("Internal note")
  expect(store.draft()).toEqual({ text: "Saved draft", note: true })
  ui.mockInput.pressKey("e", { ctrl: true })
  await frame("Conversation resolved")
  expect(store.state.active?.state).toBe("resolved")
  ui.mockInput.pressKey("e", { ctrl: true })
  await frame("Conversation reopened")
  ui.mockInput.pressKey("u", { ctrl: true })
  await frame("Marked read")
  expect(store.state.active?.unread?.operator).toBe(0)
  await client.reply("session_demo_1", "A remote update", false)
  ui.mockInput.pressKey("r", { ctrl: true })
  await frame("A remote update")
  expect(store.draft()).toEqual({ text: "Saved draft", note: true })
})

test("details follow selection, toggle without losing drafts, and adapt to terminal resizing", async () => {
  const store = new Store(demoClient())
  await store.refresh(); store.setDraft("Preserve this draft")
  ui = await testRender(() => <App store={store} />, { width: 140, height: 50 })
  await frame("DETAILS", "Portland", "Custom data", "Team")
  ui.mockInput.pressKey("b", { ctrl: true })
  await frame("Preserve this draft")
  expect(ui.captureCharFrame()).not.toContain("DETAILS")
  ui.mockInput.pressKey("b", { ctrl: true })
  await frame("DETAILS", "Portland")
  await store.open("session_demo_2")
  await frame("Starter")
  expect(ui.captureCharFrame()).not.toContain("Portland")
  ui.resize(90, 30)
  await frame("Demo Customer B")
  expect(ui.captureCharFrame()).not.toContain("DETAILS")
  ui.resize(140, 50)
  await frame("DETAILS", "Starter")
  await store.open("session_demo_1")
  await frame("Preserve this draft", "Team")
})

test("cached conversation and sidebar render while the network request is still pending", async () => {
  const client = demoClient(), store = new Store(client), get = client.get
  await store.refresh(); store.setDraft("Preserved reply")
  await store.open("session_demo_2")
  const wait = Promise.withResolvers<void>()
  client.get = async id => { await wait.promise; return get(id) }
  ui = await testRender(() => <App store={store} />, { width: 140, height: 50 })
  const opening = store.open("session_demo_1")
  try {
    await frame("saved copy", "updating…", "Preserved reply", "Portland", "Can you help me find my invoice?")
    expect(store.state.conversationLoading).toBe(true)
    expect(ui.captureCharFrame()).not.toContain("Loading messages…")
  } finally { wait.resolve(); await opening }
  await frame("Opened Demo Customer A")
  expect(ui.captureCharFrame()).not.toContain("saved copy")
})

test("cold navigation shows the selected header immediately and cannot steal focus after loading", async () => {
  const client = demoClient(), store = new Store(client), get = client.get
  await store.refresh()
  const wait = Promise.withResolvers<void>()
  client.get = async id => { await wait.promise; return get(id) }
  ui = await testRender(() => <App store={store} />, { width: 140, height: 40 })
  ui.mockInput.pressArrow("down"); ui.mockInput.pressEnter()
  try {
    await frame("Demo Customer B  ·  unresolved", "Loading messages…", "Loading details…")
    expect(store.state.selectedSession).toBe("session_demo_2")
    expect(ui.captureCharFrame()).not.toContain("Choose a conversation")
    ui.mockInput.pressEscape(); await Bun.sleep(50)
    ui.mockInput.pressKey("/")
    await frame("Search · Enter to submit")
  } finally { wait.resolve() }
  await frame("Opened Demo Customer B")
  await ui.mockInput.typeText("Customer A")
  ui.mockInput.pressEnter()
  await frame("Search: Customer A")
  expect(store.state.query).toBe("Customer A")
})

test("custom details show chosen fields and clear old values while navigation loads", async () => {
  const { parseLayout } = await import("../src/layout")
  const client = demoClient(), store = new Store(client)
  await store.refresh()
  const layout = parseLayout({ sidebar: { width: 28, sections: [{ title: "Account", fields: [{ label: "Subscription", path: ["meta", "data", "plan"] }] }] } })
  ui = await testRender(() => <App store={store} layout={layout} />, { width: 130, height: 30 })
  await frame("Account", "Subscription", "Team")
  const get = client.get, release = Promise.withResolvers<void>()
  client.get = async id => { await release.promise; return get(id) }
  const opening = store.open("session_demo_2")
  try {
    await frame("Loading details…")
    expect(ui.captureCharFrame()).not.toContain("Subscription")
    expect(ui.captureCharFrame()).not.toContain("Team")
  } finally { release.resolve(); await opening }
  await frame("Subscription", "Starter")
})
