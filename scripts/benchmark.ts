import { mkdtemp, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { existsSync } from "node:fs"
import { parseArgs } from "node:util"
import { request } from "../src/control"

const { values } = parseArgs({ options: { runs: { type: "string", default: "5" }, check: { type: "boolean" } } })
const runs = Number(values.runs)
if (!Number.isInteger(runs) || runs < 1 || runs > 30) throw new Error("--runs must be between 1 and 30")
const root = resolve(import.meta.dir, ".."), binary = join(root, `dist/crisp-tui-${process.platform}-${process.arch}`)
if (values.check && !existsSync(binary)) throw new Error("Build the native executable before checking performance budgets")
const measurements: Record<string, number[]> = {}
const record = (name: string, ms: number) => { (measurements[name] ??= []).push(ms) }
const childMetrics: Record<string, unknown> = {}
async function startup(name: string, argv: string[]) {
  const dir = await mkdtemp("/tmp/crisp-perf-")
  const socket = join(dir, "control.sock"), config = join(dir, "layout.json")
  await Bun.write(config, "{}")
  let output = "", firstFrame = false, firstData = false
  const started = performance.now()
  const child = Bun.spawn([...argv, "--demo", "--poll", "0", "--config", config], {
    cwd: root, env: { ...process.env, CRISP_TUI_SOCKET: socket, CRISP_TUI_PERF: "1", CRISPCTL_READ_ONLY: "0", TERM: "xterm-256color" },
    terminal: { cols: 160, rows: 50, data: (_, bytes) => {
      output = (output + new TextDecoder().decode(bytes)).slice(-131_072)
      if (!firstFrame && output.includes("support inbox")) { firstFrame = true; record(`${name}.first_output`, performance.now() - started) }
      if (!firstData && output.includes("Can you help me find my invoice?")) { firstData = true; record(`${name}.first_content`, performance.now() - started) }
    } },
  })
  try {
    while (!firstData && performance.now() - started < 15_000 && child.exitCode === null) await Bun.sleep(10)
    if (!firstFrame || !firstData) throw new Error(`${name} did not render the demo before the deadline`)
    childMetrics[name] = await request(socket, "perf")
    await request(socket, "goto", { session: "session_demo_2" })
    await request(socket, "goto", { session: "session_demo_1" })
    const start = performance.now()
    const navigating = request(socket, "goto", { session: "session_demo_2" })
    for (;;) {
      const state = await request(socket, "state") as { active?: { session_id: string } }
      if (state.active?.session_id === "session_demo_2") { record(`${name}.warm_state`, performance.now() - start); break }
      if (performance.now() - start > 3000) throw new Error("Warm navigation did not display the selected conversation")
      await Bun.sleep(5)
    }
    await navigating
  } finally {
    child.terminal?.write("\x03")
    const timer = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL") }, 3000)
    await child.exited; clearTimeout(timer); child.terminal?.close()
    await rm(dir, { recursive: true, force: true })
  }
}
for (const [name, argv] of [["source", [process.execPath, join(root, "src/index.ts")]],
  ...(existsSync(binary) ? [["binary", [binary]] as const] : [])] as const) {
  for (let i = 0; i < runs; i++) await startup(name, [...argv])
}
const { benchmarkRender } = await import("./benchmark-render")
let renderFailed = false
try { await benchmarkRender(runs, record) } catch (error) {
  renderFailed = true
  console.error("Render benchmark failed:", error)
}
const summary = Object.fromEntries(Object.entries(measurements).map(([name, values]) => {
  const sorted = [...values].sort((a, b) => a - b)
  const round = (n: number) => Math.round(n * 100) / 100
  return [name, { count: values.length, p50Ms: round(sorted[Math.ceil(sorted.length * 0.5) - 1]!),
    p95Ms: round(sorted[Math.ceil(sorted.length * 0.95) - 1]!), maxMs: round(sorted.at(-1)!) }]
}))
const budgets = await Bun.file(join(import.meta.dir, "performance-budgets.json")).json() as Record<string, number>
const missingMetrics = Object.keys(budgets).filter(name => !summary[name])
const violations = Object.entries(budgets).filter(([key, max]) => summary[key] && summary[key]!.p95Ms > max).map(([name, limitMs]) => ({ name, limitMs, p95Ms: summary[name]!.p95Ms }))
console.log(JSON.stringify({ schema: 1, runtime: { platform: process.platform, arch: process.arch, bun: Bun.version },
  runs, terminal: { columns: 160, rows: 50 }, synthetic: true, summary, budgets, violations, missingMetrics, renderFailed, lastStartupMetrics: childMetrics }, null, 2))
if (renderFailed || (values.check && (violations.length || missingMetrics.length))) process.exitCode = 1
