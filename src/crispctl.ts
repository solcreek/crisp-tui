import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { Conversation, CrispClient, Message, RealtimeSubscribe } from "./types"

export function command(env = process.env): string[] {
  if (env.CRISPCTL_BIN) return [env.CRISPCTL_BIN]
  try { return [Bun.which("node") || "node", fileURLToPath(import.meta.resolve("crispctl/dist/index.js"))] } catch {}
  const installed = Bun.which("crispctl")
  if (installed) return [installed]
  const sibling = resolve(import.meta.dir, "../../crisp-cli/dist/index.js")
  if (existsSync(sibling)) return [Bun.which("node") || "node", sibling]
  throw new Error("crispctl not found. Build ../crisp-cli (npm ci && npm run build), install crispctl, or set CRISPCTL_BIN to its executable.")
}

export class CliError extends Error {
  constructor(message: string, public code = 1) { super(message) }
}
export type Runner = (args: string[]) => Promise<unknown>
export function runner(prefix: string[], global: string[] = [], env = process.env): Runner {
  return async (args) => {
    const child = Bun.spawn([...prefix, ...global, "--json", ...args], {
      stdin: "ignore", stdout: "pipe", stderr: "pipe", env,
    })
    const timer = setTimeout(() => child.kill(), 30_000)
    try {
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ])
      if (code !== 0) {
        let message = "crispctl failed or timed out"
        // Only relay crispctl's structured, redacted error; never raw process output.
        try { message = JSON.parse(err).message || message } catch {}
        throw new CliError(message, code || 1)
      }
      try { return JSON.parse(out) } catch { throw new CliError("crispctl returned invalid JSON") }
    } finally { clearTimeout(timer) }
  }
}
function array<T>(value: unknown, key: string): T[] {
  if (!Array.isArray(value) || value.some(v => !v || typeof v !== "object" || !(key in v))) {
    throw new Error(`Unexpected crispctl response (expected array with ${key})`)
  }
  return value as T[]
}
export function createClient(run: Runner, profile: string, subscribe?: RealtimeSubscribe): CrispClient {
  return {
    label: profile,
    subscribe,
    list: async (page, query) => array<Conversation>(await run(query
      ? ["conversations", "search", query, "--page", String(page)]
      : ["conversations", "list", "--page", String(page)]), "session_id"),
    async get(session) {
      const value = await run(["conversations", "get", session]) as Conversation
      if (!value || value.session_id !== session) throw new Error("Unexpected conversation response")
      return value
    },
    messages: async session => array<Message>(await run(["messages", "list", session]), "content")
      .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0)),
    // Inline flag values also preserve messages beginning with '--'.
    reply: (session, text, note) => run(["reply", session, `${note ? "--note" : "--text"}=${text}`]),
    state: (session, resolved) => run([resolved ? "resolve" : "reopen", session]),
    read: session => run(["read", session]),
  }
}
