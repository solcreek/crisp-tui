// Preloaded by Node before the installed crispctl entrypoint. Never permits network I/O.
import { createRequire } from "node:module"
import assert from "node:assert/strict"
const require = createRequire(import.meta.resolve("crispctl/dist/index.js"))
const { MockAgent, setGlobalDispatcher } = require("undici")
const agent = new MockAgent()
agent.disableNetConnect()
setGlobalDispatcher(agent)
const expected = JSON.parse(process.env.TEST_CRISP_HTTP || "[]")
let calls = 0
for (const item of expected) {
  agent.get("https://api.crisp.chat").intercept({ path: item.path, method: item.method }).reply(options => {
    calls++
    const headers = new Headers(options.headers)
    assert.equal(headers.get("x-crisp-tier"), "website")
    assert.equal(headers.get("authorization"), `Basic ${Buffer.from("fixture-identifier:fixture-key").toString("base64")}`)
    if (item.body) assert.deepEqual(JSON.parse(options.body), item.body)
    return { statusCode: item.status || 200, data: item.response,
      responseOptions: { headers: { "content-type": "application/json" } } }
  })
}
process.on("beforeExit", () => {
  assert.equal(calls, expected.length, "Every expected Crisp request must be consumed")
})
