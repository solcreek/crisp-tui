import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { createTestRenderer } from "@opentui/core/testing"
import { startTui } from "../src/tui"
import { Store } from "../src/store"
import { demoClient } from "../src/demo"
import { request, serve } from "../src/control"

let ui: Awaited<ReturnType<typeof createTestRenderer>> | undefined
const directories: string[] = []
afterEach(async () => {
  ui?.renderer.destroy(); ui = undefined
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true })
})
async function socket() {
  const dir = await mkdtemp("/tmp/crisp-tui-lifecycle-")
  directories.push(dir)
  return join(dir, "control.sock")
}
const createRenderer: Parameters<typeof startTui>[3] = async options => {
  ui = await createTestRenderer({ ...options, width: 100, height: 30 })
  return ui.renderer
}

test("TUI startup, socket drafts and renderer destruction share one lifecycle", async () => {
  const path = await socket(), client = demoClient(), store = new Store(client)
  let stops = 0
  client.subscribe = () => () => { stops++ }
  await startTui(store, path, 0, createRenderer)
  await store.refresh()
  expect(await request(path, "draft", { session: "session_demo_2", text: "lifecycle draft" })).toMatchObject({ sent: false })
  await ui!.renderOnce()
  expect(ui!.captureCharFrame()).toContain("lifecycle draft")
  ui!.renderer.destroy()
  for (let i = 0; i < 50 && await Bun.file(path).exists(); i++) await Bun.sleep(10)
  expect(stops).toBe(1)
  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" })
})

test("renderer creation failure releases the socket for the next TUI", async () => {
  const path = await socket()
  await expect(startTui(new Store(demoClient()), path, 0, async () => { throw new Error("renderer failed") })).rejects.toThrow("renderer failed")
  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" })
  const next = await serve(path, () => null)
  await next.stop()
})

test("subscription startup failure destroys the renderer and releases the socket", async () => {
  const path = await socket(), client = demoClient()
  client.subscribe = () => { throw new Error("subscription failed") }
  await expect(startTui(new Store(client), path, 0, createRenderer)).rejects.toThrow("subscription failed")
  expect(ui!.renderer.isDestroyed).toBe(true)
  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" })
})
