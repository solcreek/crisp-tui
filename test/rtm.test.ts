import { expect, test } from "bun:test"
import { attachRealtime, listen } from "../src/rtm"
import { observeRealtime } from "../src/rtm-check"
import { Store } from "../src/store"
import { demoClient } from "../src/demo"
import type { RealtimeEvent, RealtimeStatus } from "../src/types"

test("crispctl NDJSON stdout events and stderr authentication are consumed separately", async () => {
  const result = await observeRealtime(listen([process.execPath, `${import.meta.dir}/fixtures/rtm-cli.ts`], []), 3000)
  expect(result).toEqual({ authenticated: true, received: 1, events: ["message:send"] })
})
test("authentication alone does not pass a real-event check", async () => {
  let stopped = false
  await expect(observeRealtime((_, status) => {
    queueMicrotask(() => status({ state: "authenticated" }))
    return () => { stopped = true }
  }, 20)).rejects.toThrow("timed out")
  expect(stopped).toBe(true)
})
test("RTM bursts coalesce and reauthentication reconciles the active conversation", async () => {
  const client = demoClient()
  let event!: (e: RealtimeEvent) => void, status!: (s: RealtimeStatus) => void, stopped = false
  client.subscribe = (e, s) => { event = e; status = s; return () => { stopped = true } }
  const store = new Store(client)
  await store.refresh()
  const list = client.list
  let reads = 0
  client.list = async (...args) => { reads++; return list(...args) }
  const stop = attachRealtime(store, 0)
  try {
    await client.reply("session_demo_1", "new remote message", false)
    for (let i = 0; i < 10; i++) event({ event: "message:received", data: {}, received_at: "" })
    await Bun.sleep(250)
    expect(reads).toBe(1)
    expect(store.state.messages.at(-1)?.content).toBe("new remote message")
    status({ state: "reconnecting" })
    expect(store.state.realtime).toBe("reconnecting")
    await client.state("session_demo_1", true)
    status({ state: "authenticated" })
    await Bun.sleep(250)
    expect(store.state.active?.state).toBe("resolved")
    expect(reads).toBe(2)
  } finally { stop() }
  expect(stopped).toBe(true)
})
