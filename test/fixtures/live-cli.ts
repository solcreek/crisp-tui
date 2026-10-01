#!/usr/bin/env bun
export {}
const args = process.argv.slice(2)
if (process.env.TEST_ARGV_FILE) await Bun.write(process.env.TEST_ARGV_FILE, JSON.stringify(args))
if (process.env.TEST_BRIDGE_EXIT) process.exit(Number(process.env.TEST_BRIDGE_EXIT))
if (!args.includes("--read-only") || process.env.CRISPCTL_READ_ONLY !== "1" || process.env.CRISPCTL_KEY !== "fake-secret" || process.env.CRISPCTL_TIER !== "website") {
  console.error(JSON.stringify({ message: "Synthetic credentials and read-only flags required" }))
  process.exit(91)
}
const conversation = { session_id: "session_fixture", state: "unresolved", meta: { nickname: "Synthetic Private Contact" } }
if (args.includes("listen")) {
  console.error(JSON.stringify({ status: "authenticated" }))
  console.log(JSON.stringify({ event: "message:send", data: {}, received_at: "" }))
  setInterval(() => {}, 1000)
} else if (args.includes("conversations")) {
  console.log(JSON.stringify(args.includes("get") ? conversation : [conversation]))
} else if (args.includes("messages")) {
  console.log(JSON.stringify([{ type: "text", content: "Synthetic private customer message", timestamp: 1 }]))
} else process.exit(92)
