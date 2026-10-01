import { expect, test } from "bun:test"
import { chmod, copyFile, mkdtemp, rm, stat } from "node:fs/promises"
import { join, resolve } from "node:path"
import { request } from "../src/control"

for (const fails of [false, true]) test(`live PTY shows credential progress before ${fails ? "an authorization failure" : "the read-only TUI"}`, async () => {
  const dir = await mkdtemp("/tmp/crisp-live-progress-"), socket = join(dir, "control.sock"), release = join(dir, "release")
  let screen = ""
  for (const [source, name] of [["op-cli.ts", "op"], ["live-cli.ts", "crispctl"]] as const) {
    const path = join(dir, name)
    await copyFile(join(import.meta.dir, "fixtures", source), path); await chmod(path, 0o700)
  }
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/index.ts"), "live", "--item", "Synthetic item"], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CRISP_TUI_SOCKET: socket,
      CRISPCTL_BIN: join(dir, "crispctl"),
      TEST_OP_WAIT_FILE: release, TEST_OP_EXIT: fails ? "1" : "0", TEST_OP_HANG: "0",
      TEST_OP_OUTPUT: JSON.stringify({ fields: [
        { label: "API Identifier", value: "fake-identifier" }, { label: "API Key", value: "fake-secret" },
        { label: "website_id", value: "11111111-1111-1111-1111-111111111111" },
      ] }), TERM: "xterm-256color" },
    terminal: { cols: 120, rows: 35, data: (_, bytes) => { screen += new TextDecoder().decode(bytes) } },
  })
  const until = async (check: () => Promise<boolean>) => {
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      try { if (await check()) return } catch {}
      await Bun.sleep(20)
    }
    throw new Error("Live progress did not reach expected state")
  }
  try {
    await until(async () => screen.includes("Reading 1Password credentials"))
    await expect(stat(socket)).rejects.toMatchObject({ code: "ENOENT" })
    expect(screen).not.toContain("support inbox")
    await Bun.write(release, "ready")
    if (fails) {
      expect(await Promise.race([child.exited, Bun.sleep(8000).then(() => "timeout")])).toBe(1)
      expect(screen).toContain("1Password could not read")
      expect(screen.replace(/\x1b\[[0-9;]*m/g, "")).toContain("\r\x1b[2K{") // Clear before the possibly colored diagnostic.
    } else {
      await until(async () => screen.includes("READ ONLY") && !!(await request(socket, "state", {}) as { initialReadComplete: boolean }).initialReadComplete)
      expect(await request(socket, "state", {})).toMatchObject({ readOnly: true })
      child.terminal!.write("\x03")
      expect(await Promise.race([child.exited, Bun.sleep(3000).then(() => "timeout")])).toBe(0)
      await expect(stat(socket)).rejects.toMatchObject({ code: "ENOENT" })
    }
    expect(screen).not.toContain("fake-secret")
    expect(screen).not.toContain("synthetic-private-stderr")
  } finally {
    if (child.exitCode === null) child.kill()
    await child.exited; child.terminal?.close()
    await rm(dir, { recursive: true, force: true })
  }
}, 15_000)
