import { createCliRenderer } from "@opentui/core"
import { render } from "@opentui/solid"
import { controller, serve } from "./control"
import type { Store } from "./store"
import type { Cleanup } from "./types"
import { App } from "./ui/App"
import { defaultLayout, type LayoutConfig } from "./layout"
import { startUpdates } from "./updates"
import { trackRendering } from "./render-performance"

export async function startTui(store: Store, path: string, pollMs: number, createRenderer = createCliRenderer, layout: LayoutConfig = defaultLayout) {
  let focus = () => {}
  const control = await store.metrics.measure("startup.socket", () => serve(path, controller(store, () => focus(), layout)))
  let stopMetrics = () => {}
  let stopUpdates: Cleanup = () => {}
  let stopping: Promise<void> | undefined
  let renderer: Awaited<ReturnType<typeof createCliRenderer>> | undefined
  const stop = () => {
    if (!stopping) {
      stopUpdates()
      stopMetrics()
      stopping = Promise.all([control.stop(), stopUpdates.done]).then(() => {})
    }
    return stopping
  }
  try {
    renderer = await store.metrics.measure("startup.renderer", () => createRenderer({ onDestroy: () => { void stop().catch(() => {}) }, exitOnCtrlC: true, gatherStats: store.metrics.enabled }))
    stopMetrics = trackRendering(renderer, store)
    await store.metrics.measure("startup.mount", () => render(() => <App store={store} bindFocus={fn => { focus = fn }} layout={layout} />, renderer!))
    if (!stopping) stopUpdates = startUpdates(store, pollMs)
    return { stop: () => { renderer?.destroy(); return stop() } }
  } catch (error) {
    renderer?.destroy()
    await stop()
    throw error
  }
}
