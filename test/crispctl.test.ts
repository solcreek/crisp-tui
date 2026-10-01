import { expect, test } from "bun:test"
import { createClient, runner } from "../src/crispctl"
import { options } from "../src/cli"
import { clean, messageText } from "../src/types"

test("adapter shares crispctl commands and passes arbitrary text as one argument", async () => {
  const calls: string[][] = []
  const client = createClient(async args => {
    calls.push(args)
    if (args[0] === "conversations") return args[1] === "get" ? { session_id: "session_1" } : [{ session_id: "session_1" }]
    if (args[0] === "messages") return [{ timestamp: 2, content: "new" }, { timestamp: 1, content: "old" }]
    return {}
  }, "sandbox")
  await client.list(2, "refund")
  await client.list(1, "")
  await client.get("session_1")
  expect((await client.messages("session_1"))[0]?.content).toBe("old")
  const text = "你好\n$(touch /tmp/never) `whoami` --note"
  await client.reply("session_1", text, false)
  await client.reply("session_1", text, true)
  await client.state("session_1", true)
  await client.state("session_1", false)
  await client.read("session_1")
  expect(calls).toEqual([
    ["conversations", "search", "refund", "--page", "2"], ["conversations", "list", "--page", "1"],
    ["conversations", "get", "session_1"], ["messages", "list", "session_1"],
    ["reply", "session_1", `--text=${text}`], ["reply", "session_1", `--note=${text}`],
    ["resolve", "session_1"], ["reopen", "session_1"], ["read", "session_1"],
  ])
})
test("subprocess runner keeps JSON stdout separate and preserves argv", async () => {
  const run = runner([process.execPath, `${import.meta.dir}/fixtures/echo.ts`], ["--profile", "sandbox"])
  expect(await run(["reply", "session", "--text", "hello\n$(whoami)"])).toEqual(["--profile", "sandbox", "--json", "reply", "session", "--text", "hello\n$(whoami)"])
})
test("runner relays structured errors and hides unstructured stderr", async () => {
  const failed = runner([process.execPath, "-e", 'console.error(JSON.stringify({message:"rate limited"})); process.exit(1)'])
  await expect(failed([])).rejects.toThrow("rate limited")
  const raw = runner([process.execPath, "-e", 'console.error("raw-secret"); process.exit(1)'])
  await expect(raw([])).rejects.toThrow("crispctl failed")
  const bad = runner([process.execPath, "-e", 'console.log("not-json")'])
  await expect(bad([])).rejects.toThrow("invalid JSON")
})
test("malformed payloads fail clearly instead of silently emptying the inbox", async () => {
  const client = createClient(async () => ({ error: true }), "test")
  await expect(client.list(1, "")).rejects.toThrow("Unexpected")
  await expect(client.messages("id")).rejects.toThrow("Unexpected")
})
test("polling has website quota conscious defaults", () => {
  expect(options([]).poll).toBe(60)
  expect(options(["--poll", "0"]).poll).toBe(0)
  expect(() => options(["--poll", "1"])).toThrow()
  expect(() => options(["--poll", "NaN"])).toThrow()
})
test("remote terminal controls are stripped; files and notes remain readable", () => {
  expect(clean("hello\x1b]52;secret\x07\nworld")).toBe("hello]52;secret\nworld")
  expect(messageText({ type: "file", content: { name: "receipt.pdf", url: "https://example.com/file" } })).toBe("[receipt.pdf] https://example.com/file")
})
