import { testRender } from "@opentui/solid"
import { Store } from "../src/store"
import { demoClient } from "../src/demo"
import { App } from "../src/ui/App"
import { Metrics } from "../src/performance"

export async function benchmarkRender(runs: number, record: (name: string, ms: number) => void) {
  for (const markdown of [false, true]) for (const size of [100, 1000]) {
    const prefix = markdown ? `render.markdown.${size}` : `render.${size}`
    for (let run = 0; run < runs; run++) {
      const client = demoClient(), store = new Store(client, new Metrics(true))
      const messages = Array.from({ length: size }, (_, index) => ({ fingerprint: index, from: index % 2 ? "operator" : "user", type: "text",
        content: markdown ? `**Synthetic message ${index}**\n1\\. Open settings\n2\\. Choose Team\nUse \`team_id\` or [help](https://example.com/help).`
          : `Synthetic message ${index}. This is a repeatable rendering workload.`, timestamp: 1_700_000_000_000 + index }))
      client.messages = async () => structuredClone(messages)
      await store.refresh()
      const start = performance.now()
      const ui = await testRender(() => <App store={store} />, { width: 160, height: 50 })
      try {
        await ui.renderOnce()
        record(`${prefix}.mount`, performance.now() - start)
        for (let i = 0; i < 3; i++) {
          const refresh = performance.now()
          await store.refresh(); await ui.renderOnce()
          record(`${prefix}.unchanged_refresh`, performance.now() - refresh)
          const draft = performance.now()
          store.setDraft(`Synthetic draft ${i}`); await ui.renderOnce()
          record(`${prefix}.draft`, performance.now() - draft)
        }
      } finally { ui.renderer.destroy() }
    }
  }
}
