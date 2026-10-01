import type { RealtimeSubscribe } from "./types"

export function observeRealtime(subscribe: RealtimeSubscribe, timeoutMs: number) {
  return new Promise<{ authenticated: true; received: number; events: string[] }>((resolve, reject) => {
    let authenticated = false, received = 0, stop = () => {}
    const events = new Set<string>()
    const timer = setTimeout(() => {
      stop()
      reject(new Error(authenticated ? "RTM authenticated; timed out waiting for a real event" : "RTM check timed out before authentication"))
    }, timeoutMs)
    const finish = () => {
      if (!authenticated || !received) return
      clearTimeout(timer); stop()
      resolve({ authenticated: true, received, events: [...events] })
    }
    stop = subscribe(event => { received++; events.add(event.event); finish() }, status => {
      if (status.state === "error") { clearTimeout(timer); stop(); reject(new Error(status.message || "RTM check failed")); return }
      if (status.state === "authenticated") { authenticated = true; finish() }
    })
  })
}
