import type { CliRenderer } from "@opentui/core"
import type { Store } from "./store"

/** Frame events mean renderer output completion, not physical screen presentation. */
export function trackRendering(renderer: CliRenderer, store: Store) {
  const metrics = store.metrics
  if (!metrics.enabled) return () => {}
  let first = true, content = false, ready = false, synced = false, pendingState: number | undefined
  let stopped = false
  let selected = store.state.selectedSession
  let navigation: { start: number; feedback: boolean; content: boolean } | undefined
  const unsubscribe = store.subscribe(() => {
    pendingState ??= metrics.now()
    if (store.state.selectedSession !== selected) {
      if (navigation) metrics.increment("navigation.superseded")
      selected = store.state.selectedSession
      navigation = { start: metrics.now(), feedback: false, content: false }
    }
  })
  const frame = () => {
    const now = metrics.now(), state = store.state
    // OpenTUI appends the JS work-duration sample after emitting "frame".
    // Its native last-frame interval includes idle time, so it is not a render duration.
    queueMicrotask(() => {
      if (stopped || renderer.isDestroyed) return
      const stats = renderer.getStats(), duration = stats.frameTimes.at(-1)
      if (duration !== undefined) metrics.record("render.frame", duration)
      // Native backend timings are microseconds and may be absent with threaded output.
      if (stats.nativeRenderTime !== undefined) metrics.record("render.native", stats.nativeRenderTime / 1000)
      if (stats.nativeStdoutWriteTime !== undefined) metrics.record("render.stdout", stats.nativeStdoutWriteTime / 1000)
    })
    if (pendingState !== undefined) { metrics.record("render.state_to_frame", now - pendingState); pendingState = undefined }
    if (first) { metrics.record("startup.first_frame", process.uptime() * 1000); first = false }
    if (!content && state.messagesReady) {
      metrics.record("startup.content_frame", process.uptime() * 1000); content = true
    }
    if (!ready && state.initialReadComplete) {
      const elapsed = process.uptime() * 1000
      metrics.record("startup.loaded_frame", elapsed)
      metrics.record("startup.ready_frame", elapsed); ready = true // Compatibility alias.
    }
    if (!synced && state.initialReadComplete && state.realtime === "authenticated" && state.realtimeSynced) {
      metrics.record("startup.synced_frame", process.uptime() * 1000); synced = true
    }
    if (navigation) {
      if (!navigation.feedback) { metrics.record("navigation.feedback_frame", now - navigation.start); navigation.feedback = true }
      if (state.messagesReady) {
        if (!navigation.content) {
          metrics.record(state.conversationCached ? "navigation.cached_frame" : "navigation.cold_frame", now - navigation.start)
          navigation.content = true
        }
        if (state.active?.session_id === selected && !state.conversationLoading && !state.messagesLoading && !state.detailsLoading && !state.conversationCached) {
          metrics.record("navigation.fresh_frame", now - navigation.start); navigation = undefined
        }
      }
    }
  }
  renderer.on("frame", frame)
  return () => { stopped = true; unsubscribe(); renderer.off("frame", frame) }
}
