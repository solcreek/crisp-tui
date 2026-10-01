import { loadLayout } from "./layout"
import { parseArgs } from "node:util"
import { loadWebsiteCredentials } from "./onepassword"
import { credentialClient } from "./session"
import { Store } from "./store"
import { socketPath } from "./control"
import { observeRealtime } from "./rtm-check"

export async function liveReadonlyMain(args: string[], readCredentials = loadWebsiteCredentials): Promise<number> {
  const { values } = parseArgs({ args, options: {
    config: { type: "string" },
    website: { type: "string" }, item: { type: "string" },
    check: { type: "boolean" }, help: { type: "boolean" },
    "rtm-timeout": { type: "string" },
  } })
  if (values.help) {
    console.log("crisp-tui live --item ITEM [--website UUID] [--config FILE]\ncrisp-tui check --item ITEM [--website UUID] [--config FILE] [--rtm-timeout SECONDS]\nWebsite ID defaults to the item's website_id field. API access uses crispctl --read-only. Credentials and customer content are never saved.")
  } else {
    try {
      if (!values.item?.trim()) throw new Error("Choose a 1Password item explicitly with --item ITEM")
      const timeout = values["rtm-timeout"] === undefined ? 0 : Number(values["rtm-timeout"])
      if (values["rtm-timeout"] !== undefined && (!values.check || !Number.isInteger(timeout) || timeout < 1 || timeout > 120)) throw new Error("--rtm-timeout requires check mode and 1–120 seconds")
      const layout = await loadLayout(values.config)
      const credentials = await readCredentials(values.item, values.website)
      const websiteId = credentials.websiteId
      const session = credentialClient(credentials)
      const store = new Store(session.client)
      if (values.check) {
        await store.list()
        // Render the real data in memory to catch data-shape/layout incompatibilities.
        // Output only aggregate diagnostics; never capture customer text to disk.
        const [{ testRender }, { createComponent }, { App }] = await Promise.all([
          import("@opentui/solid"), import("solid-js"), import("./ui/App"),
        ])
        const ui = await testRender(() => createComponent(App, { store, layout }), { width: 120, height: 35 })
        let rendered = false
        try {
          await ui.renderOnce()
          rendered = ui.captureCharFrame().includes("READ ONLY")
          if (!rendered) throw new Error("Read-only indicator was not rendered")
        } finally { ui.renderer.destroy() }
        const rtm = timeout ? await observeRealtime(session.client.subscribe!, timeout * 1000) : undefined
        console.log(JSON.stringify({
          ok: true, mode: "read-only", transport: "crispctl", website: { id: websiteId },
          conversationsOnPage: store.state.conversations.length,
          statesOnPage: store.state.conversations.reduce<Record<string, number>>((counts, c) => { const state = c.state || "unknown"; counts[state] = (counts[state] || 0) + 1; return counts }, {}),
          messagesInOpenedConversation: store.state.messages.length,
          messageTypes: [...new Set(store.state.messages.map(m => m.type))],
          tuiRendered: rendered, commands: session.commands, rtm, writes: 0,
        }, null, 2))
      } else {
        if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Run in an interactive terminal, or use live:check for a read-only connection test")
        const { startTui } = await import("./tui")
        await startTui(store, socketPath("onepassword-readonly", websiteId), 0, undefined, layout)
      }
    } catch (error) {
      console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Read-only check failed" }))
      return 1
    }
  }
  return 0
}
