import { expect, test } from "bun:test"
import { commands, controlHelp, parseControlCommand, validateCommand, controller } from "../src/commands"
import { Store } from "../src/store"
import { demoClient } from "../src/demo"
import { readOnlyClient } from "../src/readonly"

test("every control command has matching CLI syntax, socket validation and help", () => {
  for (const [method, command] of Object.entries(commands)) {
    const args = Object.entries(command.fields).filter(([, type]) => type === "string").map(([key]) => key === "session" ? "session_demo_1" : "hello")
    const flags = method === "draft" ? { note: true, replace: true } : {}
    const parsed = parseControlCommand(method, args, flags)
    expect(validateCommand(method, parsed.params).command).toBe(command)
    expect(controlHelp.some(line => line.startsWith(`ctl ${method}`))).toBe(true)
  }
})

test("invalid CLI and socket parameters are rejected consistently", () => {
  for (const method of [undefined, "send", "toString", "__proto__"]) {
    expect(() => parseControlCommand(method, [], {})).toThrow("Usage")
  }
  expect(() => parseControlCommand("goto", [], {})).toThrow("Usage")
  expect(() => parseControlCommand("state", ["extra"], {})).toThrow("Usage")
  expect(() => parseControlCommand("state", [], { note: true })).toThrow("Unknown")
  for (const input of [null, [], "text"]) expect(() => validateCommand("state", input)).toThrow("Invalid params")
  expect(() => validateCommand("toString", {})).toThrow("Unknown")
  expect(() => validateCommand("draft", { session: "id", text: " " })).toThrow("non-empty")
  expect(() => validateCommand("draft", { session: "id", text: "text", note: "false" })).toThrow("boolean")
  expect(() => validateCommand("draft", { session: "id", text: "text", replace: 1 })).toThrow("boolean")
  expect(() => validateCommand("state", { text: "extra" })).toThrow("Unknown")
})

test("read-only sessions permit navigation and snapshots but never agent drafts", async () => {
  const store = new Store(readOnlyClient(demoClient())), handle = controller(store)
  await handle("refresh", {})
  await handle("goto", { session: "session_demo_2" })
  for (const method of ["state", "screen", "messages", "conversations"]) expect(await handle(method, {})).toBeDefined()
  await expect(handle("draft", { session: "session_demo_2", text: "blocked" })).rejects.toThrow("Read-only")
  expect(store.state.drafts).toEqual({})
})

test("queued commands retain their validated arguments and recover after failure", async () => {
  const client = demoClient(), store = new Store(client), handle = controller(store)
  await store.refresh()
  const list = client.list, started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  client.list = async (...args) => { started.resolve(); await release.promise; return list(...args) }
  const refresh = handle("refresh", {})
  await started.promise
  const params = { session: "session_demo_2", text: "original" }
  const draft = handle("draft", params)
  params.session = "session_demo_3"; params.text = "changed"
  release.resolve(); await refresh; await draft
  expect(store.state.active?.session_id).toBe("session_demo_2")
  expect(store.draft().text).toBe("original")
  await expect(handle("draft", { session: "session_demo_2", text: "overwrite" })).rejects.toThrow("already exists")
  await handle("goto", { session: "session_demo_3" })
  expect(store.state.active?.session_id).toBe("session_demo_3")
})

test("expired and cancelled queued actions never change navigation or drafts", async () => {
  const client = demoClient(), store = new Store(client), handle = controller(store)
  await store.refresh()
  const list = client.list, started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  client.list = async (...args) => { started.resolve(); await release.promise; return list(...args) }
  const refresh = handle("refresh", {})
  await started.promise
  const cancellation = new AbortController()
  const draft = handle("draft", { session: "session_demo_2", text: "cancelled" }, { signal: cancellation.signal })
  cancellation.abort(new Error("disconnected"))
  release.resolve(); await refresh
  await expect(draft).rejects.toThrow("disconnected")
  await expect(handle("goto", { session: "session_demo_2" }, { deadline: Date.now() - 1 })).rejects.toThrow("expired")
  expect(store.state.active?.session_id).toBe("session_demo_1")
  expect(store.state.drafts).toEqual({})
  await handle("goto", { session: "session_demo_3" })
  expect(store.state.active?.session_id).toBe("session_demo_3")
})

test("cancelling a draft during its conversation read prevents composing or focus", async () => {
  const client = demoClient(), store = new Store(client)
  await store.refresh()
  const get = client.get, started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  client.get = async id => { started.resolve(); await release.promise; return get(id) }
  let focused = false
  const handle = controller(store, () => { focused = true }), cancellation = new AbortController()
  const draft = handle("draft", { session: "session_demo_2", text: "cancelled" }, { signal: cancellation.signal })
  await started.promise
  cancellation.abort(new Error("disconnected")); release.resolve()
  await expect(draft).rejects.toThrow("disconnected")
  expect(store.state.drafts).toEqual({})
  expect(focused).toBe(false)
})

test("control queue is bounded while snapshots remain available", async () => {
  const client = demoClient(), store = new Store(client), handle = controller(store)
  const list = client.list, release = Promise.withResolvers<void>()
  client.list = async (...args) => { await release.promise; return list(...args) }
  const pending = Array.from({ length: 64 }, () => handle("refresh", {}))
  try {
    await expect(handle("goto", { session: "session_demo_2" })).rejects.toThrow("queue is full")
    expect(await handle("state", {})).toHaveProperty("protocol", 2)
  } finally { release.resolve(); await Promise.all(pending) }
  await handle("goto", { session: "session_demo_2" })
})
