import { expect, test } from "bun:test"
import { credentialEnvironment, credentialClient } from "../src/session"
import { websiteCredentials } from "../src/onepassword"
import { readOnlyClient } from "../src/readonly"
import { demoClient } from "../src/demo"
import { Store } from "../src/store"
import { controller } from "../src/control"

const credentials = { identifier: "fake-identifier", key: "fake-secret", websiteId: "11111111-1111-1111-1111-111111111111" }
test("credential sessions force crispctl's read-only flag and environment", async () => {
  const env = credentialEnvironment(credentials, { CRISPCTL_KEY: "different", CRISPCTL_TIER: "plugin" })
  expect(env).toMatchObject({ CRISPCTL_KEY: "fake-secret", CRISPCTL_READ_ONLY: "1", CRISPCTL_TIER: "website" })
  const session = credentialClient(credentials, [process.execPath, `${import.meta.dir}/fixtures/readonly-cli.ts`])
  await session.client.list(1, "")
  await expect(session.client.reply("id", "text", false)).rejects.toThrow("Read-only")
  await expect(session.client.reply("id", "note", true)).rejects.toThrow("Read-only")
  expect(session.commands).toEqual(["conversations list"])
  expect(JSON.stringify(session.commands)).not.toContain(credentials.key)
})
test("store and agent controls cannot bypass read-only client writes", async () => {
  const client = demoClient()
  let writes = 0
  client.reply = client.state = client.read = async () => { writes++ }
  const store = new Store(readOnlyClient(client))
  await store.refresh()
  store.setDraft("not to send")
  await expect(store.send()).rejects.toThrow("Read-only")
  await expect(store.changeState()).rejects.toThrow("Read-only")
  await expect(store.markRead()).rejects.toThrow("Read-only")
  await expect(controller(store)("draft", { session: "session_demo_1", text: "not to send" })).rejects.toThrow("Read-only")
  expect(writes).toBe(0)
  expect(store.state.readOnly).toBe(true)
  expect(store.screen()).toContain("READ ONLY")
  expect(store.draft().text).toBe("not to send")
})
test("1Password mapping uses website_id without exporting credentials to config", () => {
  const item = { fields: [
    { label: "API Identifier", value: credentials.identifier },
    { label: "API Key", value: credentials.key },
    { label: "website_id", value: credentials.websiteId },
  ] }
  expect(websiteCredentials(item)).toEqual(credentials)
  expect(() => websiteCredentials({ fields: [] })).toThrow("API Identifier")
  expect(() => websiteCredentials(item, "../invalid")).toThrow("workspace UUID")
})
