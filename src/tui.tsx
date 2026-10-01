import { createCliRenderer } from "@opentui/core"
import { render } from "@opentui/solid"
import { controller, serve } from "./control"
import type { Store } from "./store"
import { App } from "./ui/App"
import { attachRealtime } from "./rtm"

export async function startTui(store: Store, path: string, pollMs: number) {
  let focus = () => {}
  const control = await serve(path, controller(store, () => focus()))
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let failures = 0
  let stopRealtime = () => {}
  const stop = () => {
    if (stopped) return
    stopped = true
    clearTimeout(timer)
    stopRealtime()
    void control.stop()
  }
  try {
    const renderer = await createCliRenderer({ onDestroy: stop, exitOnCtrlC: true })
    await render(() => <App store={store} bindFocus={fn => { focus = fn }} />, renderer)
    const refresh = async () => {
      try { await store.refresh(); failures = 0 }
      catch (error) {
        failures++
        store.update({ error: error instanceof Error ? error.message : "Refresh failed" })
      }
      if (!stopped && pollMs) timer = setTimeout(refresh, Math.min(pollMs * 2 ** failures, 900_000))
    }
    void refresh()
    if (!stopped) stopRealtime = attachRealtime(store)
  } catch (error) { stop(); throw error }
}
