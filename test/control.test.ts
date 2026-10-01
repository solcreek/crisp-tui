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
  expect(await request(p, "state")).toMatchObject({ protocol: 1, source: "DEMO · local only" })
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
    expect(await request(p, "conversations", {}, 1000)).toHaveLength(3)
    expect(await request(p, "messages", {}, 1000)).toHaveLength(1)
  } finally { release.resolve(); await refreshing }
})
