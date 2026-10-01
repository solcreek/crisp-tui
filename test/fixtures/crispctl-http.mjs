// Preloaded by Node before the installed crispctl entrypoint. Never permits network I/O.
import { createRequire } from "node:module"
import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Socket } from "node:net"
import assert from "node:assert/strict"
// Resolve from the same physical package as Node's entrypoint. Bun's isolated
// installs can expose a different Undici at the lexical symlink location.
const require = createRequire(realpathSync(fileURLToPath(import.meta.resolve("crispctl/dist/index.js"))))
// Fail closed even if a future dependency uses a different dispatcher instance.
Socket.prototype.connect = function () { throw new Error("Network disabled in crispctl contract tests") }
const { MockAgent, setGlobalDispatcher } = require("undici")
// Node 26 lazily initializes its built-in Undici dispatcher with web globals.
// Initialize it before installing the mock so a later Headers access cannot
// replace our dispatcher with a real network agent.
void globalThis.Headers
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
