import { clean, type RealtimeSubscribe } from "./types"
import type { Store } from "./store"

/** crispctl owns discovery, Socket.IO, authentication and reconnect policy. */
export function listen(prefix: string[], flags: string[], env = process.env): RealtimeSubscribe {
  return (onEvent, onStatus) => {
    let stopped = false
    let failed = false
    const child = Bun.spawn([...prefix, ...flags, "--read-only", "--json", "listen",
      "--events", "message:send,message:received,message:updated,message:removed,session:set_state"],
    { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    onStatus({ state: "connecting" })
    const error = (message: string) => {
      if (stopped) return
      failed = true
      // Do not relay unstructured subprocess output or remote payloads.
      onStatus({ state: "error", message })
    }
    const read = async (stream: ReadableStream<Uint8Array>, status: boolean) => {
      const reader = stream.getReader(), decoder = new TextDecoder()
      let buffer = ""
      try {
        while (!stopped) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          if (Buffer.byteLength(buffer) > 1_048_576) throw new Error("Oversized stream")
          let end: number
          while ((end = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
            if (!line.trim()) continue
            const item = JSON.parse(line)
            if (status) {
              if (item.status === "authenticated" || item.status === "reconnecting") onStatus({ state: item.status })
              else if (item.ok === false) error("crispctl RTM reported an error; check token access and configuration")
            } else if (typeof item.event === "string" && item.data && typeof item.data === "object" && !Array.isArray(item.data)) {
              onEvent({ event: item.event, data: item.data, received_at: item.received_at })
            }
          }
        }
      } catch {
        error("crispctl RTM stream could not be read")
        child.kill("SIGTERM")
      } finally { reader.releaseLock() }
    }
    void Promise.all([read(child.stdout, false), read(child.stderr, true), child.exited]).then(() => {
      if (!stopped && !failed) error("crispctl RTM stream ended")
    })
    return () => { stopped = true; child.kill("SIGTERM") }
  }
}

/** Coalesce bursts; fetch after any in-flight read so a reconnect cannot retain an old snapshot. */
export function attachRealtime(store: Store, minRefreshMs = 5000) {
  if (!store.client.subscribe) return () => {}
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false, dirty = false, stopped = false, last = 0
  const schedule = () => {
    if (stopped || running || timer) return
    timer = setTimeout(() => {
      timer = undefined
      if (stopped) return
      dirty = false; running = true; last = Date.now()
      void store.perform(() => store.refreshAfterCurrent()).finally(() => {
        running = false
        if (dirty) schedule()
      })
    }, Math.max(200, minRefreshMs - (Date.now() - last)))
  }
  const stop = store.client.subscribe(() => { dirty = true; schedule() }, status => {
    if (stopped) return
    store.update({ realtime: status.state, ...(status.message ? { error: clean(status.message) } : {}) })
    if (status.state === "authenticated") { dirty = true; schedule() }
  })
  return () => { stopped = true; clearTimeout(timer); stop() }
}
