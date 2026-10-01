import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import type { CliRenderer } from "@opentui/core"
import { Store } from "../src/store"
import { demoClient } from "../src/demo"
import { Metrics } from "../src/performance"
import { trackRendering } from "../src/render-performance"
import { attachRealtime } from "../src/rtm"
import { controller } from "../src/commands"
import { TestClock } from "./helpers/clock"
import type { RealtimeStatus, RealtimeEvent } from "../src/types"

function setup() {
  const client = demoClient(), clock = new TestClock(), metrics = new Metrics(true, clock.now)
  const store = new Store(client, metrics), calls = { list: 0, get: 0, messages: 0 }
  for (const key of ["list", "get", "messages"] as const) {
    const original = client[key] as (...args: any[]) => Promise<any>
    client[key] = (...args: any[]) => { calls[key]++; return original(...args) }
  }
  let status!: (s: RealtimeStatus) => void, event!: (e: RealtimeEvent) => void
  client.subscribe = (e, s) => { event = e; status = s; return () => {} }
  const stop = attachRealtime(store, 0, clock)
  return { client, clock, store, metrics, calls, stop, authenticate: () => status({ state: "authenticated" }),
    emit: () => event({ event: "message:send", data: {}, received_at: "" }) }
}

test("startup frames distinguish messages, the initial snapshot and completed RTM reconciliation", async () => {
  const { client, store, clock, metrics, authenticate, stop } = setup()
  const get = client.get, list = client.list
  const details = Promise.withResolvers<void>(), relist = Promise.withResolvers<void>()
  client.get = async id => { await details.promise; return get(id) }
  let lists = 0
  client.list = async (...args) => { if (++lists === 2) await relist.promise; return list(...args) }
  const emitter = Object.assign(new EventEmitter(), { getStats: () => ({ frameTimes: [1] }) })
  const untrack = trackRendering(emitter as unknown as CliRenderer, store)
  try {
    const initial = store.refresh(); await clock.flush()
    emitter.emit("frame")
    expect(store.state).toMatchObject({ active: null, messagesReady: true, messagesLoading: false, detailsLoading: true })
    expect(metrics.snapshot().timings["startup.content_frame"]?.count).toBe(1)
    expect(metrics.snapshot().timings["startup.loaded_frame"]).toBeUndefined()
    expect(await controller(store)("messages", {})).toMatchObject({ session: "session_demo_1", total: 1 })
    authenticate(); await clock.advance(200)
    details.resolve(); await initial; await clock.flush()
    expect(store.state.loading).toBe(true) // A queued RTM list must not delay the first snapshot milestone.
    emitter.emit("frame")
    expect(metrics.snapshot().timings["startup.loaded_frame"]?.count).toBe(1)
    expect(metrics.snapshot().timings["startup.ready_frame"]).toEqual(metrics.snapshot().timings["startup.loaded_frame"])
    expect(metrics.snapshot().timings["startup.synced_frame"]).toBeUndefined()
    relist.resolve(); await clock.flush(); emitter.emit("frame")
    expect(store.state.realtimeSynced).toBe(true)
    expect(metrics.snapshot().timings["startup.synced_frame"]?.count).toBe(1)
    emitter.emit("frame")
    expect(metrics.snapshot().timings["startup.content_frame"]?.count).toBe(1)
  } finally { details.resolve(); relist.resolve(); untrack(); stop(); await stop.done }
})

test("empty inbox completes initial loading without pretending conversation content exists", async () => {
  const store = new Store({ ...demoClient(), list: async () => [] }, new Metrics(true))
  const emitter = Object.assign(new EventEmitter(), { getStats: () => ({ frameTimes: [1] }) })
  const stop = trackRendering(emitter as unknown as CliRenderer, store)
  await store.refresh(); emitter.emit("frame")
  expect(store.metrics.snapshot().timings["startup.loaded_frame"]?.count).toBe(1)
  expect(store.metrics.snapshot().timings["startup.content_frame"]).toBeUndefined()
  expect(store.metrics.snapshot().timings["startup.synced_frame"]).toBeUndefined()
  stop()
})

test("first authentication before startup reads requires no duplicate REST requests", async () => {
  const { store, clock, calls, metrics, authenticate, stop } = setup()
  try {
    authenticate(); await store.refresh(); await clock.advance(200)
    expect(calls).toEqual({ list: 1, get: 1, messages: 1 })
    expect(store.state.realtimeSynced).toBe(true)
    expect(metrics.snapshot().counters).toMatchObject({ "reads.list_reused": 1, "reads.details_reused": 1, "reads.messages_reused": 1 })
  } finally { stop(); await stop.done }
})

test("authentication during the initial inbox request only rereads that inbox", async () => {
  const { client, store, clock, calls, authenticate, stop } = setup()
  const list = client.list, release = Promise.withResolvers<void>()
  let first = true
  client.list = async (...args) => { const value = await list(...args); if (first) { first = false; await release.promise }; return value }
  try {
    const initial = store.refresh(); await clock.flush()
    authenticate(); await clock.advance(200)
    release.resolve(); await initial; await clock.flush()
    expect(calls).toEqual({ list: 2, get: 1, messages: 1 })
    expect(store.state.realtimeSynced).toBe(true)
  } finally { release.resolve(); stop(); await stop.done }
})

test("events during an in-flight read still require a newer read and cannot mark sync complete early", async () => {
  const { client, store, clock, calls, authenticate, emit, stop } = setup()
  await store.refresh()
  const list = client.list, release = Promise.withResolvers<void>()
  let first = true
  client.list = async (...args) => { const value = await list(...args); if (first) { first = false; await release.promise }; return value }
  try {
    authenticate(); await clock.advance(200)
    emit(); release.resolve(); await clock.flush()
    expect(store.state.realtimeSynced).toBe(false)
    await clock.advance(200)
    expect(calls).toEqual({ list: 3, get: 2, messages: 2 })
    expect(store.state.realtimeSynced).toBe(true)
  } finally { release.resolve(); stop(); await stop.done }
})

test("stopping while RTM waits for startup does not launch queued API requests", async () => {
  const { client, store, clock, calls, authenticate, stop } = setup()
  const list = client.list, release = Promise.withResolvers<void>()
  client.list = async (...args) => { await release.promise; return list(...args) }
  const initial = store.refresh(); authenticate(); await clock.advance(200)
  stop(); release.resolve(); await initial; await stop.done
  expect(calls).toEqual({ list: 1, get: 1, messages: 1 })
  expect(clock.pending).toBe(0)
})

for (const failed of ["get", "messages"] as const) test(`a failed ${failed} read preserves the other resource and recovers`, async () => {
  const { client, store, clock, stop } = setup()
  const original = client[failed]
  client[failed] = async () => { throw new Error("unavailable") }
  try {
    await store.perform(() => store.refresh())
    expect(store.state.initialReadComplete).toBe(false)
    expect(store.state).toMatchObject({ detailsLoading: false, messagesLoading: false, error: "unavailable" })
    if (failed === "get") { expect(store.state.messagesReady).toBe(true); expect(store.state.messages).toHaveLength(1) }
    else expect(store.state.active?.session_id).toBe("session_demo_1")
    Object.assign(client, { [failed]: original })
    await store.refresh(); await clock.flush()
    expect(store.state.initialReadComplete).toBe(true)
    expect(store.state.error).toBe("")
  } finally { stop(); await stop.done }
})

test("details render before a slow message read and empty messages are ready only after completion", async () => {
  const { client, store, clock, stop } = setup(), release = Promise.withResolvers<void>()
  client.messages = async () => { await release.promise; return [] }
  const initial = store.refresh(); await clock.flush()
  expect(store.state.active?.session_id).toBe("session_demo_1")
  expect(store.state).toMatchObject({ detailsLoading: false, messagesLoading: true, messagesReady: false, initialReadComplete: false })
  release.resolve(); await initial
  expect(store.state).toMatchObject({ messagesReady: true, initialReadComplete: true })
  stop(); await stop.done
})

test("a failed RTM catch-up is retried by manual refresh and cannot count as synced", async () => {
  const { client, store, clock, authenticate, stop } = setup()
  await store.refresh()
  const messages = client.messages
  client.messages = async () => { throw new Error("offline") }
  try {
    authenticate(); await clock.advance(200)
    expect(store.state.realtimeSynced).toBe(false)
    expect(store.state.error).toBe("offline")
    client.messages = messages
    await store.refresh()
    expect(store.state.realtimeSynced).toBe(true)
    expect(store.state.error).toBe("")
  } finally { stop(); await stop.done }
})

test("a new search after authentication can satisfy reconciliation without restoring the older list", async () => {
  const { client, store, clock, authenticate, calls, stop } = setup()
  const list = client.list, release = Promise.withResolvers<void>()
  let first = true
  client.list = async (...args) => { const rows = await list(...args); if (first) { first = false; await release.promise }; return rows }
  try {
    const initial = store.refresh(); await clock.flush()
    authenticate(); await store.list("Customer B")
    release.resolve(); await initial; await clock.advance(200)
    expect(calls.list).toBe(2)
    expect(store.state.query).toBe("Customer B")
    expect(store.state.selectedSession).toBe("session_demo_2")
    expect(store.state.realtimeSynced).toBe(true)
  } finally { release.resolve(); stop(); await stop.done }
})

test("partial failure never records fresh navigation or completes initial loading", async () => {
  const { client, store, metrics, stop } = setup()
  client.get = async () => { throw new Error("details unavailable") }
  const emitter = Object.assign(new EventEmitter(), { getStats: () => ({ frameTimes: [1] }) })
  const untrack = trackRendering(emitter as unknown as CliRenderer, store)
  await store.perform(() => store.refresh()); emitter.emit("frame")
  expect(metrics.snapshot().timings["navigation.cold_frame"]?.count).toBe(1)
  expect(metrics.snapshot().timings["navigation.fresh_frame"]).toBeUndefined()
  expect(metrics.snapshot().timings["startup.loaded_frame"]).toBeUndefined()
  untrack(); stop(); await stop.done
})

test("a superseded background read clears its loading flags after a failed send", async () => {
  const { client, store, clock, stop } = setup()
  await store.refresh()
  const messages = client.messages, release = Promise.withResolvers<void>()
  client.messages = async id => { await release.promise; return messages(id) }
  const refreshing = store.refresh(); await clock.flush()
  client.reply = async () => { throw new Error("not sent") }
  store.setDraft("Keep this draft")
  await store.perform(() => store.send())
  release.resolve(); await refreshing
  expect(store.state).toMatchObject({ detailsLoading: false, messagesLoading: false, error: "not sent" })
  expect(store.draft().text).toBe("Keep this draft")
  stop(); await stop.done
})
