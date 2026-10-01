import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { defaultLayout, loadLayout, parseLayout } from "../src/layout"
import { conversationDetails } from "../src/details"
import { Store } from "../src/store"
import { demoClient } from "../src/demo"
import { controller } from "../src/commands"
import { readOnlyClient } from "../src/readonly"

test("local layout resolution uses flag, environment, XDG and home paths without writing defaults", async () => {
  const dir = await mkdtemp("/tmp/crisp-layout-")
  try {
    expect(await loadLayout(undefined, { HOME: dir })).toEqual(defaultLayout)
    expect(await Bun.file(`${dir}/.config/crisp-tui/config.json`).exists()).toBe(false)
    await mkdir(`${dir}/.config/crisp-tui`, { recursive: true })
    await Bun.write(`${dir}/.config/crisp-tui/config.json`, JSON.stringify({ sidebar: { width: 28 } }))
    expect((await loadLayout(undefined, { HOME: dir })).sidebar.width).toBe(28)
    await mkdir(`${dir}/xdg/crisp-tui`, { recursive: true })
    await Bun.write(`${dir}/xdg/crisp-tui/config.json`, JSON.stringify({ sidebar: { width: 30 } }))
    expect((await loadLayout(undefined, { HOME: dir, XDG_CONFIG_HOME: `${dir}/xdg` })).sidebar.width).toBe(30)
    const explicit = `${dir}/explicit.json`
    await Bun.write(explicit, JSON.stringify({ sidebar: { enabled: false } }))
    expect((await loadLayout(undefined, { HOME: dir, CRISP_TUI_CONFIG: explicit })).sidebar.enabled).toBe(false)
    expect((await loadLayout(`${dir}/.config/crisp-tui/config.json`, { CRISP_TUI_CONFIG: explicit })).sidebar.width).toBe(28)
    await expect(loadLayout(`${dir}/missing.json`, {})).rejects.toThrow("Cannot read TUI configuration")
    await Bun.write(explicit, "synthetic-private-invalid-json")
    await expect(loadLayout(explicit, {})).rejects.toThrow("must be valid JSON")
    await Bun.write(explicit, " ".repeat(65_537))
    await expect(loadLayout(explicit, {})).rejects.toThrow("exceeds 64 KiB")
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("layout schema rejects mistakes, executable settings and unsafe paths", () => {
  const invalid = [null, [], { sidebar: null }, { plugin: "run.sh" }, { sidebar: { width: 23 } }, { sidebar: { width: 61 } },
    { sidebar: { enabled: "yes" } }, { sidebar: { sections: Array(9).fill({}) } },
    { sidebar: { sections: [{ title: "x", fields: [], path: ["meta"] }] } },
    { sidebar: { sections: [{ title: "x", fields: Array(21).fill({}) }] } },
    { sidebar: { sections: [{ title: "\x1bunsafe", fields: [] }] } },
    { sidebar: { sections: [{ title: "x", fields: [{ label: "x", path: ["__proto__"] }] }] } },
    { sidebar: { sections: [{ title: "x", path: "meta.data" }] } },
    { sidebar: { sections: [{ title: "x", fields: [{ label: "x", path: [] }] }] } },
  ]
  for (const config of invalid) expect(() => parseLayout(config)).toThrow()
  expect(parseLayout({ sidebar: { sections: [] } }).sidebar.sections).toEqual([])
})

test("configured fields preserve order and false/zero values, and sanitize terminal controls", () => {
  const config = parseLayout({ sidebar: { sections: [{ title: "Account", fields: [
    { label: "Plan", path: ["meta", "data", "plan"] },
    { label: "Enabled", path: ["meta", "data", "enabled"] },
    { label: "Seats", path: ["meta", "data", "seats"] },
    { label: "Literal key", path: ["meta", "data", "a.b"] },
    { label: "Missing", path: ["meta", "data", "absent"] },
  ] }] } }).sidebar
  const groups = conversationDetails({ session_id: "synthetic", meta: { data: { plan: "Pro\x1b[31m\n", enabled: false, seats: 0, "a.b": "literal" } } }, config)
  expect(groups[0]!.rows.map(row => row.label)).toEqual(["Plan", "Enabled", "Seats", "Literal key", "Missing"])
  expect(groups[0]!.rows.map(row => row.value)).toEqual(["Pro[31m ", "false", "0", "literal", "—"])
  expect(conversationDetails(null, config)).toEqual([])
})

test("automatic custom data stays bounded and missing data is an empty group", () => {
  const config = parseLayout({ sidebar: { sections: [{ title: "Custom", path: ["meta", "data"] }] } }).sidebar
  const data = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`field${i}`, "x".repeat(1000)]))
  data["k".repeat(100)] = "long key"
  const group = conversationDetails({ session_id: "synthetic", meta: { data } }, config)[0]!
  expect(group.truncated).toBe(true)
  expect(group.rows).toHaveLength(20)
  expect(group.rows[0]).toMatchObject({ truncated: true })
  expect(group.rows[0]!.value.length).toBe(512)
  const longKey = conversationDetails({ session_id: "synthetic", meta: { data: { ["k".repeat(100)]: null } } }, config)[0]!.rows[0]!
  expect(longKey.label.length).toBe(80)
  expect(longKey.value).toBe("—")
  expect(conversationDetails({ session_id: "synthetic" }, config)[0]!.rows).toEqual([])
})

test("agent details use the running TUI's configuration and remain read-only", async () => {
  const client = demoClient(), store = new Store(readOnlyClient(client))
  await store.refresh()
  const layout = parseLayout({ sidebar: { sections: [{ title: "Account", fields: [{ label: "Plan", path: ["meta", "data", "plan"] }] }] } })
  const revision = store.state.revision
  const result = await controller(store, undefined, layout)("details", {})
  expect(result).toMatchObject({ revision, session: "session_demo_1", sections: [{ title: "Account", rows: [{ label: "Plan", value: "Team" }] }] })
  expect(store.state.revision).toBe(revision)
  await store.open("session_demo_2")
  expect(await controller(store, undefined, layout)("details", {})).toMatchObject({ session: "session_demo_2", sections: [{ rows: [{ value: "Starter" }] }] })
})
