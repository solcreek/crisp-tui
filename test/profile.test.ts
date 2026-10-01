import { expect, test } from "bun:test"
import { chmod, copyFile, mkdtemp, rm, stat } from "node:fs/promises"
import { join, resolve } from "node:path"
import { request } from "../src/control"

for (const mode of ["flag", "env", "tier", "missing"] as const) test(`profile TUI through PTY: ${mode}`, async () => {
  const dir = await mkdtemp("/tmp/crisp-profile-"), socket = join(dir, "control.sock"), calls = join(dir, "calls.jsonl")
  const executable = join(dir, "crispctl")
  await copyFile(join(import.meta.dir, "fixtures/profile-cli.mjs"), executable)
  await chmod(executable, 0o700)
  // An isolated environment prevents personal profiles or real credentials from being used.
  const env = { PATH: process.env.PATH, HOME: dir, TERM: "xterm-256color", CRISPCTL_BIN: executable,
    CRISPCTL_CONFIG: join(dir, "config.json"), CRISP_TUI_SOCKET: socket, TEST_CALLS: calls, TEST_AUTH: mode,
    ...(mode === "env" ? { CRISPCTL_READ_ONLY: "1" } : {}) }
  let screen = ""
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/index.ts"),
    "--profile", "synthetic", "--website", "11111111-1111-1111-1111-111111111111", "--poll", "0",
    ...(mode === "env" ? [] : ["--read-only"])], {
    env, terminal: { cols: 100, rows: 30, data: (_, data) => { screen += new TextDecoder().decode(data) } },
  })
  async function until(check: () => Promise<boolean>) {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      try { if (await check()) return } catch {}
      await Bun.sleep(20)
    }
    throw new Error(`Profile TUI did not become ready: ${screen.slice(-1000)}`)
  }
  try {
    if (mode === "tier" || mode === "missing") {
      expect(await Promise.race([child.exited, Bun.sleep(10_000).then(() => "timeout")])).toBe(1)
      expect(screen).toContain(mode === "tier" ? "--tier website" : "Incomplete crispctl website credentials")
      await expect(stat(socket)).rejects.toMatchObject({ code: "ENOENT" })
    } else {
      await until(async () => {
        const state = await request(socket, "state") as { active?: { session_id: string }; realtime: string }
        return state.active?.session_id === "session_fixture" && state.realtime === "authenticated"
      })
      expect(await request(socket, "state")).toMatchObject({ readOnly: true, source: "synthetic · website 11111111-1111-1111-1111-111111111111" })
      expect(await request(socket, "messages")).toMatchObject({ items: [{ content: "Synthetic profile message" }] })
      await expect(request(socket, "draft", { session: "session_fixture", text: "blocked" })).rejects.toThrow("Read-only")
      // Human write shortcuts are disabled too.
      child.terminal!.write("\x05\x15\r")
      child.terminal!.write("\x03")
      expect(await Promise.race([child.exited, Bun.sleep(5000).then(() => "timeout")])).toBe(0)
      await expect(stat(socket)).rejects.toMatchObject({ code: "ENOENT" })
    }
    const entries = (await Bun.file(calls).text()).trim().split("\n").map(line => JSON.parse(line) as { args: string[]; pid: number })
    expect(entries[0]!.args.slice(-2)).toEqual(["auth", "show"])
    for (const { args } of entries) {
      expect(args).toContain("--read-only")
      expect(args.some(arg => ["reply", "resolve", "reopen", "read"].includes(arg))).toBe(false)
    }
    if (mode === "tier" || mode === "missing") expect(entries).toHaveLength(1)
    else {
      const listener = entries.find(entry => entry.args.includes("listen"))!
      expect(listener).toBeDefined()
      expect(() => process.kill(listener.pid, 0)).toThrow()
    }
  } finally {
    if (child.exitCode === null) child.kill()
    await child.exited; child.terminal?.close()
    await rm(dir, { recursive: true, force: true })
  }
}, 20_000)
