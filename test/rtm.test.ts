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

test("synchronous RTM completion releases the returned subscription exactly once", async () => {
  let stops = 0
  const result = await observeRealtime((event, status) => {
    status({ state: "authenticated" })
    event({ event: "message:send", data: {}, received_at: "" })
    event({ event: "message:send", data: {}, received_at: "" })
    return () => { stops++ }
  }, 100)
  expect(result.received).toBe(1)
  expect(stops).toBe(1)
})

test("synchronous subscription failures reject without leaving a timeout", async () => {
  const { TestClock } = await import("./helpers/clock")
  const clock = new TestClock()
  await expect(observeRealtime(() => { throw new Error("spawn failed") }, 100, clock)).rejects.toThrow("spawn failed")
  expect(clock.pending).toBe(0)
})

test("RTM observes UTF-8 chunks, drains final records, and reports child exit", async () => {
  const events: RealtimeEvent[] = [], statuses: RealtimeStatus[] = []
  const code = `const b = Buffer.from(JSON.stringify({event:'message:send',data:{text:'こんにちは'},received_at:''}));
    process.stdout.write(b.subarray(0,60)); setTimeout(()=>process.stdout.write(b.subarray(60)),20);`
  const stop = listen([process.execPath, "-e", code], [])(e => events.push(e), s => statuses.push(s))
  await stop.done
  expect(events).toHaveLength(1)
  expect(events[0]?.data.text).toBe("こんにちは")
  expect(statuses.at(-1)?.state).toBe("error")
})

for (const code of ["process.stdout.write('invalid-secret\\n');setInterval(()=>{},1000)", "process.stdout.write('x'.repeat(1048577));setInterval(()=>{},1000)"]) {
  test("invalid or oversized RTM input stops the child without exposing its content", async () => {
    const statuses: RealtimeStatus[] = []
    const stop = listen([process.execPath, "-e", code], [])(() => {}, s => statuses.push(s))
    await stop.done
    expect(statuses.filter(s => s.state === "error")).toHaveLength(1)
    expect(JSON.stringify(statuses)).not.toContain("invalid-secret")
  })
}

test("cancellation ignores late RTM output", async () => {
  const ready = Promise.withResolvers<void>(), events: RealtimeEvent[] = [], statuses: RealtimeStatus[] = []
  const code = `process.on('SIGTERM',()=>process.stdout.write(JSON.stringify({event:'message:send',data:{},received_at:''})+'\\n'));
    process.stderr.write(JSON.stringify({status:'authenticated'})+'\\n');setInterval(()=>{},1000)`
  const stop = listen([process.execPath, "-e", code], [])(e => events.push(e), s => {
    statuses.push(s); if (s.state === "authenticated") ready.resolve()
  })
  await ready.promise
  stop(); stop()
  await stop.done
  expect(events).toHaveLength(0)
  expect(statuses.some(s => s.state === "error")).toBe(false)
})

test("cancellation forcibly terminates a child that ignores SIGTERM", async () => {
  const ready = Promise.withResolvers<void>()
  const code = `process.on('SIGTERM',()=>{});
    process.stderr.write(JSON.stringify({status:'authenticated'})+'\\n');setInterval(()=>{},1000)`
  const stop = listen(["node", "-e", code, "--"], [])(() => {}, s => {
    if (s.state === "authenticated") ready.resolve()
  })
  await ready.promise
  stop()
  await stop.done
}, 5000)
