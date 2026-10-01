import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { Conversation, CrispClient, Message, RealtimeSubscribe } from "./types"
import { capture } from "./subprocess"

export function command(env = process.env): string[] {
  if (env.CRISPCTL_BIN) return [env.CRISPCTL_BIN]
  // The npm Node launcher resolves its own dependency, independent of the working directory.
  if (env.CRISP_TUI_NODE && env.CRISP_TUI_CRISPCTL) return [env.CRISP_TUI_NODE, env.CRISP_TUI_CRISPCTL]
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
export function runner(prefix: string[], global: string[] = [], env = process.env, timeoutMs = 30_000): Runner {
  return async (args) => {
    const { stdout, stderr, code, timedOut } = await capture([...prefix, ...global, "--json", ...args], timeoutMs, env)
    if (timedOut) throw new CliError("crispctl timed out; refresh before retrying a write")
    if (code !== 0) {
      let message = "crispctl failed or timed out"
      // Only relay crispctl's structured, redacted error; never raw process output.
      try {
        const error = JSON.parse(stderr)
        if (typeof error?.message === "string" && error.message) message = error.message
      } catch {}
      throw new CliError(message, code || 1)
    }
    try { return JSON.parse(stdout) } catch { throw new CliError("crispctl returned invalid JSON") }
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
