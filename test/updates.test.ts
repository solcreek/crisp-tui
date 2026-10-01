import { expect, test } from "bun:test"
import { startUpdates } from "../src/updates"
import { attachRealtime } from "../src/rtm"
import { Store } from "../src/store"
import { demoClient } from "../src/demo"
import { TestClock } from "./helpers/clock"
import type { RealtimeEvent, RealtimeStatus } from "../src/types"

test("polling backs off after failures, resets after success, and stops cleanly", async () => {
  const clock = new TestClock(), client = demoClient(), list = client.list
  let reads = 0
  client.list = async (...args) => { if (++reads <= 2) throw new Error("offline"); return list(...args) }
  const store = new Store(client), stop = startUpdates(store, 60_000, clock)
  await clock.flush()
  expect(reads).toBe(1)
  expect(store.state.error).toBe("offline")
  await clock.advance(119_999); expect(reads).toBe(1)
  await clock.advance(1); expect(reads).toBe(2)
  await clock.advance(240_000); expect(reads).toBe(3)
  expect(store.state.error).toBe("")
  await clock.advance(60_000); expect(reads).toBe(4)
  stop(); stop()
  expect(clock.pending).toBe(0)
  await clock.advance(900_000); expect(reads).toBe(4)
})

test("stopping an in-flight poll prevents rescheduling and late errors", async () => {
  const clock = new TestClock(), client = demoClient(), deferred = Promise.withResolvers<never>()
  client.list = () => deferred.promise
  const store = new Store(client), stop = startUpdates(store, 60_000, clock)
  stop()
  deferred.reject(new Error("late error"))
  await clock.flush()
  expect(clock.pending).toBe(0)
  expect(store.state.error).toBe("")
})

test("poll zero performs only startup refresh and still cleans up RTM", async () => {
  const clock = new TestClock(), client = demoClient(), list = client.list
  let reads = 0, stops = 0
  client.list = (...args) => { reads++; return list(...args) }
  client.subscribe = () => () => { stops++ }
  const stop = startUpdates(new Store(client), 0, clock)
  await clock.flush(); await clock.advance(900_000)
  expect(reads).toBe(1)
  stop(); stop()
  expect(stops).toBe(1)
  expect(clock.pending).toBe(0)
})

test("a synchronous subscription failure cancels already scheduled reconciliation", () => {
  const clock = new TestClock(), client = demoClient()
  client.subscribe = (_, status) => {
    status({ state: "authenticated" })
    throw new Error("subscription failed")
  }
  expect(() => startUpdates(new Store(client), 60_000, clock)).toThrow("subscription failed")
  expect(clock.pending).toBe(0)
})

test("stopping in-flight RTM reconciliation suppresses late errors and cleans up once", async () => {
  const clock = new TestClock(), client = demoClient(), deferred = Promise.withResolvers<never>()
  let stops = 0
  client.list = () => deferred.promise
  client.subscribe = (_, status) => { status({ state: "authenticated" }); return () => { stops++ } }
  const store = new Store(client), stop = attachRealtime(store, 5000, clock)
  await clock.advance(200)
  stop(); stop()
  deferred.reject(new Error("late error"))
  await clock.flush()
  expect(stops).toBe(1)
  expect(clock.pending).toBe(0)
  expect(store.state.error).toBe("")
})

test("RTM bursts and events during a read reconcile again after the minimum interval", async () => {
  const clock = new TestClock(), client = demoClient(), store = new Store(client)
  await store.refresh()
  let event!: (value: RealtimeEvent) => void, status!: (value: RealtimeStatus) => void
  client.subscribe = (e, s) => { event = e; status = s; return () => {} }
  const list = client.list, release = Promise.withResolvers<void>()
  let reads = 0
  client.list = async (...args) => { if (++reads === 1) await release.promise; return list(...args) }
  const stop = attachRealtime(store, 5000, clock)
  const emit = () => event({ event: "message:send", data: {}, received_at: "" })
  for (let i = 0; i < 10; i++) emit()
  await clock.advance(200); expect(reads).toBe(1)
  emit(); status({ state: "authenticated" })
  release.resolve(); await clock.flush()
  await clock.advance(4999); expect(reads).toBe(1)
  await clock.advance(1); expect(reads).toBe(2)
  stop()
  emit(); status({ state: "reconnecting" })
  expect(clock.pending).toBe(0)
  expect(store.state.realtime).toBe("authenticated")
})

for (const source of ["poll", "rtm"] as const) test(`${source} shutdown waits for successful in-flight reads and leaves no work after done`, async () => {
  const clock = new TestClock(), client = demoClient(), list = client.list
  const release = Promise.withResolvers<void>()
  let reads = 0
  client.list = async (...args) => { reads++; await release.promise; return list(...args) }
  if (source === "rtm") client.subscribe = (_, status) => { status({ state: "authenticated" }); return () => {} }
  const store = new Store(client)
  const stop = source === "poll" ? startUpdates(store, 60_000, clock) : attachRealtime(store, 5000, clock)
  await clock.advance(200)
  expect(reads).toBe(1)
  stop()
  let finished = false
  const done = stop.done!.then(() => { finished = true })
  await clock.flush()
  expect(finished).toBe(false)
  release.resolve(); await done
  expect(store.state.active?.session_id).toBe("session_demo_1")
  const revision = store.state.revision
  await clock.advance(900_000)
  expect(reads).toBe(1)
  expect(store.state.revision).toBe(revision)
  expect(clock.pending).toBe(0)
})

test("first authentication replaces a pending event debounce; reconnect retains minimum spacing", async () => {
  const clock = new TestClock(), client = demoClient(), store = new Store(client)
  await store.refresh()
  let event!: (value: RealtimeEvent) => void, status!: (value: RealtimeStatus) => void
  client.subscribe = (e, s) => { event = e; status = s; return () => {} }
  const list = client.list
  let reads = 0
  client.list = (...args) => { reads++; return list(...args) }
  const stop = attachRealtime(store, 5000, clock)
  event({ event: "message:send", data: {}, received_at: "" })
  await clock.advance(100)
  expect(reads).toBe(0)
  status({ state: "authenticated" })
  expect(clock.pending).toBe(1)
  await clock.advance(0)
  expect(reads).toBe(1)
  expect(store.state.realtimeSynced).toBe(true)
  status({ state: "reconnecting" }); status({ state: "authenticated" })
  expect(store.state.realtimeSynced).toBe(false)
  await clock.advance(4999); expect(reads).toBe(1)
  await clock.advance(1); expect(reads).toBe(2)
  expect(store.state.realtimeSynced).toBe(true)
  stop(); await stop.done
})

test("shutdown in the first authentication turn cancels reconciliation before any reads", async () => {
  const clock = new TestClock(), client = demoClient()
  let reads = 0
  client.list = async () => { reads++; return [] }
  client.subscribe = (_, status) => { status({ state: "authenticated" }); return () => {} }
  const stop = attachRealtime(new Store(client), 5000, clock)
  stop(); await stop.done; await clock.advance(0)
  expect(reads).toBe(0)
  expect(clock.pending).toBe(0)
})
