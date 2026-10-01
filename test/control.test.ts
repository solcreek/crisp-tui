import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { controller, NotRunning, request, serve } from "../src/control"
import { demoClient } from "../src/demo"
import { Store } from "../src/store"

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn() })
async function path() {
  const dir = await mkdtemp("/tmp/otc-test-")
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return join(dir, "control.sock")
}
test("private socket exposes state and drafts end to end", async () => {
  const p = await path(), store = new Store(demoClient())
  await store.refresh()
  const server = await serve(p, controller(store)); cleanups.push(() => server.stop())
  expect((await stat(p)).mode & 0o777).toBe(0o600)
  expect(await request(p, "state")).toMatchObject({ protocol: 2, source: "DEMO · local only" })
  expect(await request(p, "draft", { session: "session_demo_2", text: "中文草稿", note: true })).toMatchObject({ sent: false })
  expect(await request(p, "screen")).toContain("中文草稿")
  await expect(request(p, "send")).rejects.toThrow("Unknown")
  await expect(request(p, "state", { surprise: true })).rejects.toThrow("Unknown state parameter")
  await expect(request(p, "draft", { session: "session_demo_2", text: "text", note: "false" })).rejects.toThrow("boolean")
  await expect(serve(p, controller(store))).rejects.toThrow("already running")
})
test("missing socket has a distinct error", async () => {
  await expect(request(await path(), "state")).rejects.toBeInstanceOf(NotRunning)
})
test("server never removes an ordinary file at socket path", async () => {
  const p = await path()
  await writeFile(p, "keep")
  await expect(serve(p, () => null)).rejects.toThrow("non-socket")
  expect(await Bun.file(p).text()).toBe("keep")
})

test("socket snapshots remain responsive while refresh is waiting on network I/O", async () => {
  const client = demoClient(), store = new Store(client)
  await store.refresh()
  const list = client.list, started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  client.list = async (...args) => { started.resolve(); await release.promise; return list(...args) }
  const p = await path(), server = await serve(p, controller(store))
  cleanups.push(() => server.stop())
  const refreshing = request(p, "refresh")
  await started.promise
  try {
    expect(await request(p, "state", {}, 1000)).toMatchObject({ loading: true, selectedSession: "session_demo_1" })
    expect(await request(p, "screen", {}, 1000)).toContain("Demo Customer A")
    expect(await request(p, "conversations", {}, 1000)).toMatchObject({ total: 3 })
    expect(await request(p, "messages", {}, 1000)).toMatchObject({ total: 1 })
  } finally { release.resolve(); await refreshing }
})

for (const reason of ["timeout", "disconnect", "shutdown"] as const) test(`${reason} cancels queued socket commands; shutdown drains active reads`, async () => {
  const { createConnection } = await import("node:net")
  const client = demoClient(), store = new Store(client)
  await store.refresh()
  const list = client.list, started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  client.list = async (...args) => { started.resolve(); await release.promise; return list(...args) }
  const received = Promise.withResolvers<void>(), aborted = Promise.withResolvers<void>(), handle = controller(store)
  const p = await path(), server = await serve(p, (method, params, context) => {
    if (method === "draft") {
      received.resolve()
      context.signal!.addEventListener("abort", () => aborted.resolve(), { once: true })
    }
    return handle(method, params, context)
  })
  cleanups.push(() => server.stop())
  const refreshing = request(p, "refresh").catch(() => {})
  await started.promise
  let socket: ReturnType<typeof createConnection> | undefined
  let drafting: Promise<unknown> | undefined
  let stopped: Promise<void> | undefined
  try {
    if (reason === "timeout") drafting = request(p, "draft", { session: "session_demo_2", text: "expired" }, 100).catch(e => e)
    else {
      socket = createConnection(p)
      socket.on("error", () => {})
      socket.on("connect", () => socket!.write(JSON.stringify({ id: 1, method: "draft", params: { session: "session_demo_2", text: "cancelled" } }) + "\n"))
    }
    await received.promise
    if (reason === "timeout") expect((await drafting as Error).message).toContain("timed out")
    else if (reason === "disconnect") socket!.destroy()
    else {
      let drained = false
      stopped = server.stop().then(() => { drained = true })
      await Promise.resolve()
      expect(drained).toBe(false)
    }
    await aborted.promise
  } finally {
    release.resolve(); socket?.destroy()
    await refreshing; await (stopped ?? server.stop())
  }
  expect(store.state.drafts).toEqual({})
  expect(store.state.active?.session_id).toBe("session_demo_1")
})
