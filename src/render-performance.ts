import type { CliRenderer } from "@opentui/core"
import type { Store } from "./store"

/** Frame events mean renderer output completion, not physical screen presentation. */
export function trackRendering(renderer: CliRenderer, store: Store) {
  const metrics = store.metrics
  if (!metrics.enabled) return () => {}
  let first = true, ready = false, pendingState: number | undefined
  let stopped = false
  let started = store.state.loading || !!store.state.active
  let selected = store.state.selectedSession
  let navigation: { start: number; feedback: boolean; content: boolean } | undefined
  const unsubscribe = store.subscribe(() => {
    started ||= store.state.loading
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
    if (started && !ready && !state.loading && !state.conversationLoading && (state.active || !state.conversations.length) && !state.error) {
      metrics.record("startup.ready_frame", process.uptime() * 1000); ready = true
    }
    if (navigation) {
      if (!navigation.feedback) { metrics.record("navigation.feedback_frame", now - navigation.start); navigation.feedback = true }
      if (state.active?.session_id === selected) {
        if (!navigation.content) {
          metrics.record(state.conversationCached ? "navigation.cached_frame" : "navigation.cold_frame", now - navigation.start)
          navigation.content = true
        }
        if (!state.conversationLoading && !state.conversationCached) {
          metrics.record("navigation.fresh_frame", now - navigation.start); navigation = undefined
        }
      }
    }
  }
  renderer.on("frame", frame)
  return () => { stopped = true; unsubscribe(); renderer.off("frame", frame) }
}
