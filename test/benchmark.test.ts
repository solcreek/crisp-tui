import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import budgets from "../scripts/performance-budgets.json"

const root = resolve(import.meta.dir, "..")
const hasBinary = existsSync(join(root, `dist/crisp-tui-${process.platform}-${process.arch}`))
const missing = "render.1000.draft"

async function benchmark(mode: "fail" | "missing" | "complete" | "over", check = false) {
  const dir = await mkdtemp("/tmp/crisp-benchmark-test-")
  try {
    const preload = join(dir, "preload.ts")
    // Inject deterministic render results in a separate process; exercise the real
    // CLI reporting/exit path without changing global mocks or the budget file.
    await Bun.write(preload, `import { mock } from "bun:test"
mock.module(${JSON.stringify(join(root, "scripts/benchmark-render.tsx"))}, () => ({
  benchmarkRender: async (_runs, record) => {
    const budgets = ${JSON.stringify(budgets)}
    for (const [name, limit] of Object.entries(budgets)) {
      if (!name.startsWith("render.")) continue
      if (${JSON.stringify(mode)} === "missing" && name === ${JSON.stringify(missing)}) continue
      record(name, ${JSON.stringify(mode)} === "over" ? limit + 1 : 1)
    }
    if (${JSON.stringify(mode)} === "fail") throw new Error("Synthetic render operation failed")
  }
}))`)
    const child = Bun.spawn([process.execPath, "--preload", preload, "scripts/benchmark.ts", "--runs", "1", ...(check ? ["--check"] : [])], {
      cwd: root, stdout: "pipe", stderr: "pipe",
    })
    const timer = setTimeout(() => child.kill("SIGKILL"), 25_000)
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      return { report: JSON.parse(stdout), stderr, code }
    } finally { clearTimeout(timer) }
  } finally { await rm(dir, { recursive: true, force: true }) }
}

test("benchmark preserves failure diagnostics on stderr and partial JSON on stdout", async () => {
  const { report, stderr, code } = await benchmark("fail")
  expect(code).toBe(1)
  expect(stderr).toContain("Render benchmark failed:")
  expect(stderr).toContain("Synthetic render operation failed")
  expect(stderr).toContain("benchmarkRender")
  expect(report.renderFailed).toBe(true)
  expect(report.summary["source.first_output"].count).toBe(1)
  expect(report.summary["render.100.mount"].count).toBe(1)
  expect(JSON.stringify(report)).not.toContain("Synthetic render operation failed")
}, 30_000)

test("benchmark reports missing metrics without failing measurement-only mode", async () => {
  const { report, code } = await benchmark("missing")
  expect(code).toBe(0)
  expect(report.renderFailed).toBe(false)
  expect(report.missingMetrics).toContain(missing)
}, 30_000)

test.skipIf(!hasBinary)("benchmark check fails missing or over-budget metrics and accepts a complete report", async () => {
  const missingResult = await benchmark("missing", true)
  expect(missingResult.code).toBe(1)
  expect(missingResult.report.missingMetrics).toEqual([missing])
  expect(missingResult.report.violations).toEqual([])
  expect(missingResult.report.renderFailed).toBe(false)
  const over = await benchmark("over", true)
  expect(over.code).toBe(1)
  expect(over.report.violations).toContainEqual({ name: missing, limitMs: budgets[missing], p95Ms: budgets[missing] + 1 })
  const complete = await benchmark("complete", true)
  expect(complete.code).toBe(0)
  expect(complete.report.missingMetrics).toEqual([])
  expect(complete.report.violations).toEqual([])
}, 90_000)
