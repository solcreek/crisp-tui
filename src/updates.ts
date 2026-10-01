import type { Store } from "./store"
import type { Cleanup } from "./types"
import { attachRealtime } from "./rtm"
import { systemClock, type Clock } from "./scheduling"

/** Own the update timers separately from the terminal renderer. */
export function startUpdates(store: Store, pollMs: number, clock: Clock = systemClock): Cleanup {
  let stopped = false, failures = 0
  let cancelPoll: (() => void) | undefined
  let stopRealtime: Cleanup = () => {}
  const stop: Cleanup = () => {
    if (stopped) return
    stopped = true
    cancelPoll?.()
    stopRealtime()
  }
  const refresh = async () => {
    try { await store.refresh(); failures = 0 }
    catch (error) {
      failures++
      if (!stopped) await store.perform(async () => { throw error })
    }
    if (!stopped && pollMs) cancelPoll = clock.after(Math.min(pollMs * 2 ** failures, 900_000), () => { void refresh() })
  }
  try {
    stopRealtime = attachRealtime(store, 5000, clock)
    stop.done = stopRealtime.done
    void refresh()
    return stop
  } catch (error) { stop(); throw error }
}
