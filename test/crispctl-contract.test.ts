import { afterAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createClient, runner, CliError } from "../src/crispctl"
import pkg from "../package.json"

const scratch = await mkdtemp(join(tmpdir(), "crisp-contract-"))
afterAll(() => rm(scratch, { recursive: true, force: true }))
const website = "11111111-1111-1111-1111-111111111111", session = "session_fixture"
const site = `/v1/website/${website}`, conversation = { session_id: session, state: "unresolved" }
interface Request { method: string; path: string; body?: unknown; status?: number; response: unknown }
const ok = (data: unknown) => ({ error: false, reason: "ok", data })
function run(expected: Request[] = [], flags: string[] = []) {
  return runner([Bun.which("node")!, "--import", `${import.meta.dir}/fixtures/crispctl-http.mjs`,
    fileURLToPath(import.meta.resolve("crispctl/dist/index.js"))], ["--profile", "contract", "--website", website, ...flags], {
    PATH: process.env.PATH,
    CRISPCTL_CONFIG: join(scratch, "nonexistent.json"),
    CRISPCTL_IDENTIFIER: "fixture-identifier", CRISPCTL_KEY: "fixture-key", CRISPCTL_TIER: "website",
    TEST_CRISP_HTTP: JSON.stringify(expected),
  })
}
function client(request: Request, flags: string[] = []) { return createClient(run([request], flags), "contract") }

// Each contract may start several real Node processes; cold CI runners need
// more than the unit-test default of five seconds for the whole sequence.
test("installed crispctl exposes the expected version and redacted website auth", async () => {
  expect(await run()(["--version"])).toEqual({ version: pkg.dependencies.crispctl })
  expect(await run()(["auth", "show"])).toMatchObject({ tier: "website", key: "set", identifier: "fixture-identifier", website_id: website })
}, 30_000)

test("the HTTP fixture rejects raw sockets even outside the mocked dispatcher", async () => {
  const invoke = runner([Bun.which("node")!, "--import", `${import.meta.dir}/fixtures/crispctl-http.mjs`, "--eval",
    'try { require("node:net").connect(1, "127.0.0.1"); process.exit(90) } catch (error) { console.log(JSON.stringify({ message: error.message })) }', "--"], [], { PATH: process.env.PATH })
  expect(await invoke([])).toEqual({ message: "Network disabled in crispctl contract tests" })
}, 30_000)

test("real crispctl parses adapter list, search, get and message arguments", async () => {
  expect(await client({ method: "GET", path: `${site}/conversations/2`, response: ok([conversation]) }).list(2, "")).toEqual([conversation])
  const query = "receipt & invoice"
  expect(await client({ method: "GET", path: `${site}/conversations/3?search_query=receipt+%26+invoice&search_type=text`, response: ok([conversation]) }).list(3, query)).toEqual([conversation])
  expect(await client({ method: "GET", path: `${site}/conversation/${session}`, response: ok(conversation) }).get(session)).toEqual(conversation)
  const messages = [{ timestamp: 2, content: "new" }, { timestamp: 1, content: "old" }]
  expect(await client({ method: "GET", path: `${site}/conversation/${session}/messages`, response: ok(messages) }).messages(session)).toEqual(messages.toReversed())
}, 30_000)

test("real crispctl preserves arbitrary reply/note content and mutation payloads in mocked HTTP", async () => {
  const text = "--flag\n你好 $(whoami) `literal`"
  for (const note of [false, true]) {
    await client({ method: "POST", path: `${site}/conversation/${session}/message`,
      body: { type: note ? "note" : "text", from: "operator", origin: "chat", content: text }, response: ok({ fingerprint: 1 }) }).reply(session, text, note)
  }
  for (const resolved of [true, false]) {
    await client({ method: "PATCH", path: `${site}/conversation/${session}/state`,
      body: { state: resolved ? "resolved" : "unresolved" }, response: ok({}) }).state(session, resolved)
  }
  await client({ method: "PATCH", path: `${site}/conversation/${session}/read`,
    body: { from: "operator", origin: "chat" }, response: ok({}) }).read(session)
}, 30_000)

test("real crispctl blocks every adapter write in read-only mode before HTTP", async () => {
  const api = createClient(run([], ["--read-only"]), "contract")
  for (const write of [() => api.reply(session, "text", false), () => api.reply(session, "note", true),
    () => api.state(session, true), () => api.state(session, false), () => api.read(session)]) {
    await expect(write()).rejects.toThrow("read-only mode")
  }
}, 30_000)

test("real crispctl read-only mode also blocks local credential changes", async () => {
  await expect(run([], ["--read-only"])(["auth", "set", "--identifier", "fixture-new-id",
    "--key", "fixture-new-key", "--tier", "website"])).rejects.toThrow("read-only mode")
  expect(await Bun.file(join(scratch, "nonexistent.json")).exists()).toBe(false)
}, 30_000)

test("real crispctl exposes the TUI's RTM events through Commander without API access", async () => {
  const catalog = await run([], ["--read-only"])(["listen", "--list-events"]) as { events: { event: string; tiers: string[] }[] }
  for (const event of ["message:send", "message:received", "message:updated", "message:removed", "session:set_state"]) {
    expect(catalog.events.find(item => item.event === event)?.tiers).toContain("website")
  }
}, 30_000)

test("real crispctl API errors retain exit codes and redact the token", async () => {
  try {
    await client({ method: "GET", path: `${site}/conversations/1`, status: 403,
      response: { error: true, reason: "unauthorized", data: { message: "denied fixture-key" } } }).list(1, "")
    throw new Error("Expected API failure")
  } catch (error) {
    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).code).not.toBe(0)
    expect((error as Error).message).toContain("denied")
    expect((error as Error).message).not.toContain("fixture-key")
  }
}, 30_000)
