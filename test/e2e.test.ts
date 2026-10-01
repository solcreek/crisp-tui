import { expect, test } from "bun:test"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"

const binary = resolve(import.meta.dir, `../dist/crisp-tui-${process.platform}-${process.arch}`)
const installed = process.env.CRISP_TUI_TEST_INSTALLED
if (process.env.CRISP_TUI_TEST_INSTALLED_ONLY && !installed) throw new Error("Installed package test requires CRISP_TUI_TEST_INSTALLED")
const targets = process.env.CRISP_TUI_TEST_INSTALLED_ONLY ? ["installed"]
  : ["source", ...(existsSync(binary) ? ["binary"] : []), ...(installed ? ["installed"] : [])]
for (const target of targets) test(`${target}: PTY TUI and separate ctl process share drafts, send, and shut down cleanly`, async () => {
  const dir = await mkdtemp("/tmp/otc-e2e-")
  const path = join(dir, "control.sock")
  const argv: string[] = target === "installed" ? (process.env.CRISP_TUI_TEST_ARGV ? JSON.parse(process.env.CRISP_TUI_TEST_ARGV) : [resolve(installed!)]) : target === "binary"
    ? [binary]
    : [process.execPath, resolve(import.meta.dir, "../src/index.ts")]
  const env = { ...process.env, CRISP_TUI_SOCKET: path, TERM: "xterm-256color" }
  let screen = ""
  const child = Bun.spawn([...argv, "--demo", "--poll", "0"], {
    env, cwd: target === "installed" ? dir : undefined,
    terminal: { cols: 100, rows: 30, data: (_, data) => { screen += new TextDecoder().decode(data) } },
  })
  async function ctl(...args: string[]) {
    const process = Bun.spawn([...argv, "ctl", ...args], { env, cwd: target === "installed" ? dir : undefined, stdout: "pipe", stderr: "pipe" })
    const [out, err, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited])
    if (code) throw new Error(err)
    return JSON.parse(out)
  }
  async function until(check: () => Promise<boolean>, label: string) {
    const end = Date.now() + (target === "installed" ? 15_000 : 5000)
    while (Date.now() < end) {
      try { if (await check()) return } catch {}
      await Bun.sleep(30)
    }
    throw new Error(`Timed out: ${label}\n${screen.slice(-2000)}`)
  }
  try {
    // Let npx finish installing and launch the TUI before another npx process
    // touches the same cache to send control commands.
    await until(async () => screen.includes("support inbox"), "TUI rendered")
    await until(async () => !!(await ctl("state")).active, "startup")
    const draft = await ctl("draft", "session_demo_2", "PTY agent proposal", "--note")
    expect(draft.sent).toBe(false)
    const state = await ctl("state")
    expect(state.protocol).toBe(2)
    const record = await ctl("read", "drafts", "session_demo_2", "--revision", String(state.revision))
    expect(JSON.parse(record.text)).toEqual({ text: "PTY agent proposal", note: true })
    expect(record.nextOffset).toBeNull()
    const page = await ctl("conversations", "--offset", "1", "--limit", "1", "--revision", String(state.revision))
    expect(page.items[0].session_id).toBe("session_demo_2")
    expect(page.nextOffset).toBe(2)
    expect((await ctl("messages")).items.length).toBe(1)
    await until(async () => screen.includes("PTY agent proposal"), "draft displayed in terminal")
    child.terminal!.write("\r")
    await until(async () => (await ctl("messages")).items.some((m: { content: string; type: string }) => m.content === "PTY agent proposal" && m.type === "note"), "human Enter sends note")
    child.terminal!.write("\x03")
    const code = await Promise.race([child.exited, Bun.sleep(3000).then(() => "timeout")])
    expect(code).toBe(0)
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" })
  } finally {
    if (child.exitCode === null) child.kill()
    await child.exited
    child.terminal?.close()
    await rm(dir, { recursive: true, force: true })
  }
}, 30_000)
