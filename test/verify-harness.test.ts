import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { visibleScreen } from "../.cursor/skills/verify-crisp-tui/harness.ts"

const root = resolve(import.meta.dir, "..")
const harness = resolve(root, ".cursor/skills/verify-crisp-tui/harness.ts")

test("visible screen keeps a glyph the terminal did not redraw", () => {
  const esc = "\x1b"
  const bytes = new TextEncoder().encode(`${esc}[1;1HConversation reopened${esc}[1;1HMark${esc}[1;6Hd read`)
  const row = visibleScreen(bytes).split("\n")[0]
  expect(row?.startsWith("Marked read")).toBe(true)
  expect(new TextDecoder().decode(bytes).includes("Marked read")).toBe(false)
})

function run(args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>(done => {
    const child = spawn(process.execPath, [harness, ...args], { cwd: root, env: process.env })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", chunk => { stdout += chunk })
    child.stderr.on("data", chunk => { stderr += chunk })
    child.on("close", code => done({ code: code ?? 1, stdout, stderr }))
  })
}

test("one of two concurrent launches owns the run id", async () => {
  const runId = `r${Date.now().toString(36)}`
  const runDir = `/tmp/crisp-tui-verify/${runId}`
  try {
    const results = await Promise.all([run(["launch", "--run", runId]), run(["launch", "--run", runId])])
    const wins = results.filter(result => result.code === 0)
    const losses = results.filter(result => result.code !== 0)
    if (wins.length !== 1 || losses.length !== 1) {
      throw new Error(results.map(result => `code=${result.code}\n${result.stdout}\n${result.stderr}`).join("\n---\n"))
    }
    const win = JSON.parse(wins[0]!.stdout) as { ok: boolean; source: string; activeSession: string; runId: string; protocol: number }
    expect(win).toMatchObject({ ok: true, source: "DEMO · local only", activeSession: "session_demo_1", runId, protocol: 2 })
    const loss = JSON.parse(losses[0]!.stdout) as { ok: boolean; error: string }
    expect(loss.ok).toBe(false)
    expect(loss.error).toContain(`Run directory already exists for ${runId}`)
    const doctor = await run(["doctor", "--run", runId])
    expect(doctor.code).toBe(0)
    expect(JSON.parse(doctor.stdout).ok).toBe(true)
    expect(existsSync(runDir)).toBe(true)
  } finally {
    await run(["cleanup", "--run", runId])
  }
}, { timeout: 40_000 })
