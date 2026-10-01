import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import type { CliRenderer } from "@opentui/core"
import { Metrics } from "../src/performance"
import { trackRendering } from "../src/render-performance"
import { Store } from "../src/store"
import { demoClient } from "../src/demo"
import { controller } from "../src/commands"

test("metrics bound samples, report percentiles and never retain arbitrary names or errors", async () => {
  let now = 0
  const metrics = new Metrics(true, () => now, 3)
  for (const value of [1, 2, 3, 4]) metrics.record("client.get", value)
  expect(metrics.snapshot().timings["client.get"]).toMatchObject({ count: 4, samples: 3, meanMs: 2.5, maxMs: 4, p50Ms: 3, p95Ms: 4 })
  const finish = metrics.start("startup.auth")
  now = 10; finish(); finish()
  expect(metrics.snapshot().timings["startup.auth"]?.count).toBe(1)
  expect(await metrics.measure("client.messages", async () => { now += 2; return 42 })).toBe(42)
  await expect(metrics.measure("client.messages", async () => { throw new Error("private credential") })).rejects.toThrow("private credential")
  expect(() => metrics.sync("crispctl.parse", () => { throw new Error("private payload") })).toThrow()
  metrics.record("private session" as never, 1)
  metrics.record("client.get", NaN); metrics.record("client.get", -1)
  metrics.increment("private identifier" as never); metrics.increment("cache.hit")
  expect(metrics.snapshot().timings["client.messages"]).toMatchObject({ count: 2, failures: 1 })
  expect(metrics.snapshot().counters).toEqual({ "cache.hit": 1 })
  expect(JSON.stringify(metrics.snapshot())).not.toContain("private")
  expect(() => new Metrics(true, undefined, 0)).toThrow("Invalid metric sample capacity")
})

test("disabled metrics preserve operations without collecting samples", async () => {
  const metrics = new Metrics(false)
  expect(await metrics.measure("client.get", async () => 1)).toBe(1)
  expect(metrics.sync("cache.lookup", () => 2)).toBe(2)
  metrics.record("client.get", 10); metrics.increment("cache.hit"); metrics.start("client.get")()
  expect(metrics.snapshot()).toMatchObject({ enabled: false, timings: {}, counters: {} })
})

test("frame tracking separates cold/cached feedback and converts native microseconds to milliseconds", async () => {
  let now = 0
  const metrics = new Metrics(true, () => now), store = new Store(demoClient(), metrics)
  const emitter = new EventEmitter()
  const renderer = Object.assign(emitter, { getStats: () => ({ frameTimes: [2.5], nativeLastFrameTime: 999999, nativeRenderTime: 1000, nativeStdoutWriteTime: 500 }) }) as unknown as CliRenderer
  const stop = trackRendering(renderer, store)
  emitter.emit("frame")
  expect(metrics.snapshot().timings["startup.first_frame"]?.count).toBe(1)
  expect(metrics.snapshot().timings["startup.ready_frame"]).toBeUndefined()
  now = 10; store.update({ loading: true, selectedSession: "a", conversationLoading: true })
  now = 12; emitter.emit("frame")
  now = 20; store.update({ loading: false, active: { session_id: "a" }, conversationLoading: false })
  now = 23; emitter.emit("frame")
  expect(metrics.snapshot().timings["navigation.cold_frame"]?.meanMs).toBe(13)
  expect(metrics.snapshot().timings["startup.ready_frame"]?.count).toBe(1)
  now = 30; store.update({ selectedSession: "b", active: { session_id: "b" }, conversationCached: true, conversationLoading: true })
  now = 32; emitter.emit("frame")
  expect(metrics.snapshot().timings["navigation.cached_frame"]?.meanMs).toBe(2)
  now = 34; store.update({ selectedSession: "c", active: null })
  expect(metrics.snapshot().counters["navigation.superseded"]).toBe(1)
  now = 40; store.update({ active: { session_id: "c" }, conversationCached: false, conversationLoading: false })
  emitter.emit("frame")
  await Promise.resolve()
  const report = metrics.snapshot()
  expect(report.timings["render.frame"]?.meanMs).toBe(2.5)
  expect(report.timings["render.native"]?.meanMs).toBe(1)
  expect(report.timings["render.stdout"]?.meanMs).toBe(0.5)
  expect(report.timings["navigation.fresh_frame"]?.count).toBe(2)
  stop()
  emitter.emit("frame"); store.update({ status: "no frame listener" })
  expect(metrics.snapshot().timings["render.frame"]?.count).toBe(report.timings["render.frame"]?.count)
  expect(await controller(store)("perf", {})).toEqual(metrics.snapshot())
  expect(trackRendering(renderer, new Store(demoClient(), new Metrics(false)))()).toBeUndefined()
})
