import { clean, type Cleanup, type RealtimeSubscribe } from "./types"
import type { Store } from "./store"
import { systemClock, type Clock } from "./scheduling"

/** crispctl owns discovery, Socket.IO, authentication and reconnect policy. */
export function listen(prefix: string[], flags: string[], env = process.env): RealtimeSubscribe {
  return (onEvent, onStatus) => {
    let stopped = false
    let failed = false
    let forceKill: ReturnType<typeof setTimeout> | undefined
    const child = Bun.spawn([...prefix, ...flags, "--read-only", "--json", "listen",
      "--events", "message:send,message:received,message:updated,message:removed,session:set_state"],
    { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    const readers = [child.stdout.getReader(), child.stderr.getReader()]
    const stop: Cleanup = () => {
      if (stopped) return
      stopped = true
      for (const reader of readers) void reader.cancel().catch(() => {})
      if (child.exitCode === null) {
        child.kill("SIGTERM")
        forceKill = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL") }, 1000)
      }
    }
    const error = (message: string) => {
      if (stopped || failed) return
      failed = true
      try { onStatus({ state: "error", message }) } finally { stop() }
    }
    const parse = (line: string, status: boolean) => {
      if (stopped || !line.trim()) return
      const item = JSON.parse(line)
      if (status) {
        if (item.status === "authenticated" || item.status === "reconnecting") onStatus({ state: item.status })
        else if (item.ok === false) error("crispctl RTM reported an error; check token access and configuration")
      } else if (typeof item.event === "string" && item.data && typeof item.data === "object" && !Array.isArray(item.data)) {
        onEvent({ event: item.event, data: item.data, received_at: item.received_at })
      }
    }
    const read = async (reader: (typeof readers)[number], status: boolean) => {
      const decoder = new TextDecoder()
      let buffer = ""
      try {
        while (!stopped) {
          const { value, done } = await reader.read()
          if (stopped) break
          buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
          let end: number
          while ((end = buffer.indexOf("\n")) !== -1) {
            if (Buffer.byteLength(buffer.slice(0, end)) > 1_048_576) throw new Error("Oversized record")
            parse(buffer.slice(0, end), status)
            buffer = buffer.slice(end + 1)
          }
          if (Buffer.byteLength(buffer) > 1_048_576) throw new Error("Oversized record")
          if (done) { parse(buffer, status); break }
        }
      } catch {
        error("crispctl RTM stream could not be read")
      } finally { reader.releaseLock() }
    }
    stop.done = Promise.all([read(readers[0]!, false), read(readers[1]!, true), child.exited])
      .then(() => { if (!stopped) error("crispctl RTM stream ended") })
      .finally(() => clearTimeout(forceKill))
    onStatus({ state: "connecting" })
    return stop
  }
}

/** Coalesce bursts; fetch after any in-flight read so a reconnect cannot retain an old snapshot. */
export function attachRealtime(store: Store, minRefreshMs = 5000, clock: Clock = systemClock): Cleanup {
  if (!store.client.subscribe) return () => {}
  let cancelTimer: (() => void) | undefined
  let running = false, dirty = false, stopped = false, last = 0
  const schedule = () => {
    if (stopped || running || cancelTimer) return
    cancelTimer = clock.after(Math.max(200, minRefreshMs - (clock.now() - last)), () => {
      cancelTimer = undefined
      if (stopped) return
      dirty = false; running = true; last = clock.now()
      void store.refreshAfterCurrent().catch(async error => {
        if (!stopped) await store.perform(async () => { throw error })
      }).finally(() => {
        running = false
        if (dirty) schedule()
      })
    })
  }
  try {
    const stop = store.client.subscribe(() => { if (!stopped) { dirty = true; schedule() } }, status => {
      if (stopped) return
      store.update({ realtime: status.state, ...(status.message ? { error: clean(status.message) } : {}) })
      if (status.state === "authenticated") { dirty = true; schedule() }
    })
    return Object.assign(() => {
      if (stopped) return
      stopped = true; cancelTimer?.(); stop()
    }, { done: stop.done })
  } catch (error) { stopped = true; cancelTimer?.(); throw error }
}
