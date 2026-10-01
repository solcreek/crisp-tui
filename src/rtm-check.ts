import type { Cleanup, RealtimeSubscribe } from "./types"
import { systemClock, type Clock } from "./scheduling"

export function observeRealtime(subscribe: RealtimeSubscribe, timeoutMs: number, clock: Clock = systemClock) {
  return new Promise<{ authenticated: true; received: number; events: string[] }>((resolve, reject) => {
    let authenticated = false, received = 0, finished = false
    let stop: Cleanup | undefined
    const events = new Set<string>()
    const finish = (error?: Error) => {
      if (finished) return
      finished = true
      cancelTimer()
      stop?.()
      if (error) reject(error)
      else resolve({ authenticated: true, received, events: [...events] })
    }
    const cancelTimer = clock.after(timeoutMs, () => finish(new Error(authenticated
      ? "RTM authenticated; timed out waiting for a real event"
      : "RTM check timed out before authentication")))
    try {
      stop = subscribe(event => {
        if (finished) return
        received++; events.add(event.event)
        if (authenticated) finish()
      }, status => {
        if (finished) return
        if (status.state === "error") finish(new Error(status.message || "RTM check failed"))
        else if (status.state === "authenticated") { authenticated = true; if (received) finish() }
      })
      // A subscriber may emit its result synchronously, before returning cleanup.
      if (finished) stop()
    } catch (error) { finish(error instanceof Error ? error : new Error("RTM subscription failed")) }
  })
}
