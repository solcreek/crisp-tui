import { afterAll, afterEach, expect, spyOn, test } from "bun:test"
import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadWebsiteCredentials } from "../src/onepassword"
import { liveReadonlyMain } from "../src/live-readonly"
import { main, exitCode } from "../src/cli"
import { CliError, command } from "../src/crispctl"
import { NotRunning, serve, controller } from "../src/control"
import { Store } from "../src/store"
import { demoClient } from "../src/demo"

const scratch = await mkdtemp(join(tmpdir(), "crisp-entrypoints-"))
for (const [source, name] of [["op-cli.ts", "op"], ["live-cli.ts", "crispctl"]] as const) {
  const target = join(scratch, name)
  await copyFile(join(import.meta.dir, "fixtures", source), target)
  await chmod(target, 0o700)
}
afterAll(() => rm(scratch, { recursive: true, force: true }))
const original = new Map<string, string | undefined>()
function environment(values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    if (!original.has(key)) original.set(key, process.env[key])
    process.env[key] = value
  }
}
afterEach(() => {
  for (const [key, value] of original) value === undefined ? delete process.env[key] : process.env[key] = value
  original.clear()
})
const website = "11111111-1111-1111-1111-111111111111"
const item = { fields: [
  { label: "API Identifier", value: "fake-identifier" },
  { label: "API Key", value: "fake-secret" },
  { label: "website_id", value: website },
] }
function fixtures(output = JSON.stringify(item)) {
  environment({ CRISPCTL_BIN: join(scratch, "crispctl"),
    CRISPCTL_CONFIG: join(scratch, "nonexistent.json"), TEST_OP_OUTPUT: output, TEST_OP_EXIT: "0", TEST_OP_HANG: "0", TEST_BRIDGE_EXIT: "" })
}
const readCredentials = (name: string, id?: string) => loadWebsiteCredentials(name, id, join(scratch, "op"))

test("1Password subprocess preserves item argv and never exposes raw failures", async () => {
  fixtures()
  const argv = join(scratch, "argv.json")
  environment({ TEST_ARGV_FILE: argv })
  const name = "Item with spaces $(literal)"
  expect(await readCredentials(name)).toEqual({ identifier: "fake-identifier", key: "fake-secret", websiteId: website })
  expect(await Bun.file(argv).json()).toEqual(["item", "get", name, "--format", "json"])
  environment({ TEST_OP_EXIT: "1" })
  await expect(readCredentials(name)).rejects.toThrow("1Password could not read")
  environment({ TEST_OP_EXIT: "0", TEST_OP_OUTPUT: "synthetic-secret-not-json" })
  await expect(readCredentials(name)).rejects.toThrow("1Password returned invalid JSON")
})

test("live check exercises rendering and RTM with synthetic credentials, printing aggregates only", async () => {
  fixtures()
  const log = spyOn(console, "log").mockImplementation(() => {})
  try {
    expect(await liveReadonlyMain(["--item", "Synthetic item", "--check", "--rtm-timeout", "2"], readCredentials)).toBe(0)
    const output = String(log.mock.calls.at(-1)?.[0])
    expect(JSON.parse(output)).toMatchObject({ ok: true, mode: "read-only", writes: 0, tuiRendered: true,
      conversationsOnPage: 1, messagesInOpenedConversation: 1, rtm: { authenticated: true, received: 1 } })
    for (const secret of ["fake-secret", "Synthetic Private Contact", "Synthetic private customer message"]) expect(output).not.toContain(secret)
  } finally { log.mockRestore() }
})

test("1Password deadline rejects partial credentials instead of waiting indefinitely", async () => {
  fixtures()
  environment({ TEST_OP_HANG: "1" })
  await expect(loadWebsiteCredentials("Synthetic item", undefined, join(scratch, "op"), 200)).rejects.toThrow("1Password request timed out")
})

test("live entrypoint rejects missing items and invalid RTM bounds before credentials", async () => {
  const error = spyOn(console, "error").mockImplementation(() => {})
  try {
    for (const args of [[], ["--item", "item", "--rtm-timeout", "2"], ["--item", "item", "--check", "--rtm-timeout", "121"]]) {
      expect(await liveReadonlyMain(args)).toBe(1)
      expect(JSON.parse(String(error.mock.calls.at(-1)?.[0])).ok).toBe(false)
    }
  } finally { error.mockRestore() }
})

test("CLI help, validation and exit-code mapping", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {})
  try {
    expect(await main(["--help"])).toBe(0)
    expect(String(log.mock.calls.at(-1)?.[0])).toContain("ctl draft SESSION TEXT")
    expect(await main(["live", "--help"])).toBe(0)
    expect(await main(["check", "--help"])).toBe(0)
    for (const args of [["--unknown"], ["wat"], ["ctl", "state", "--demo"], ["ctl", "draft", "missing-text"]]) {
      await expect(main(args)).rejects.toBeInstanceOf(CliError)
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) await expect(main([])).rejects.toThrow("interactive terminal")
    expect(exitCode(new NotRunning())).toBe(3)
    expect(exitCode(new CliError("usage", 2))).toBe(2)
    expect(exitCode(new Error("other"))).toBe(1)
  } finally { log.mockRestore() }
})

test("CLI control uses the shared registry and formats JSON and text responses", async () => {
  const socket = join(scratch, "control.sock"), store = new Store(demoClient())
  environment({ CRISP_TUI_SOCKET: socket })
  await store.refresh()
  const server = await serve(socket, controller(store)), log = spyOn(console, "log").mockImplementation(() => {})
  try {
    expect(await main(["ctl", "draft", "session_demo_2", "from CLI", "--note"])).toBe(0)
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ sent: false, draft: { length: 8, note: true } })
    expect(await main(["ctl", "screen"])).toBe(0)
    expect(String(log.mock.calls.at(-1)?.[0])).toContain("Internal note draft: from CLI")
  } finally { log.mockRestore(); await server.stop() }
})

test("CLI bridge preserves arguments and the child exit code", async () => {
  fixtures()
  const argv = join(scratch, "bridge-argv.json")
  environment({ TEST_ARGV_FILE: argv, TEST_BRIDGE_EXIT: "7" })
  const args = ["--json", "reply", "session", "--text=--literal\n$(text)"]
  expect(await main(["cli", ...args])).toBe(7)
  expect(await Bun.file(argv).json()).toEqual(args)
  expect(command({ CRISPCTL_BIN: "/synthetic/path" })).toEqual(["/synthetic/path"])
  expect(command({})[1]).toEndWith("crispctl/dist/index.js")
})
