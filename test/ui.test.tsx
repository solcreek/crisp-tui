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
