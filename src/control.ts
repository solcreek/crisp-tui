import { createConnection, createServer, type Socket } from "node:net"
import { chmod, lstat, mkdir, unlink } from "node:fs/promises"
import { dirname, join } from "node:path"
import { createHash } from "node:crypto"
import type { Store } from "./store"

const LIMIT = 1_048_576
export function socketPath(profile = "sandbox", website = "") {
  const key = createHash("sha256").update(`${profile}:${website}`).digest("hex").slice(0, 12)
  return process.env.CRISP_TUI_SOCKET || join("/tmp", `crisp-tui-${process.getuid?.() ?? "user"}`, `${key}.sock`)
}
export class NotRunning extends Error {}
export function request(path: string, method: string, params: unknown = {}, timeout = 70_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path)
    let buffer = ""
    const finish = (error?: Error, value?: unknown) => {
      clearTimeout(timer); socket.destroy()
      error ? reject(error) : resolve(value)
    }
    const timer = setTimeout(() => finish(new Error("TUI control request timed out")), timeout)
    socket.setEncoding("utf8")
    socket.on("connect", () => socket.write(JSON.stringify({ id: 1, method, params }) + "\n"))
    socket.on("error", (e: NodeJS.ErrnoException) => finish(e.code === "ENOENT" || e.code === "ECONNREFUSED" ? new NotRunning("No TUI running for this profile/socket") : e))
    socket.on("end", () => finish(new Error("TUI closed the connection")))
    socket.on("data", chunk => {
      buffer += chunk
      if (Buffer.byteLength(buffer) > LIMIT) return finish(new Error("Control response too large"))
      if (!buffer.includes("\n")) return
      try {
        const reply = JSON.parse(buffer.slice(0, buffer.indexOf("\n")))
        if (reply.id !== 1 || typeof reply.ok !== "boolean") throw new Error("Invalid control response")
        finish(reply.ok ? undefined : new Error(reply.error), reply.result)
      } catch (e) { finish(e instanceof Error ? e : new Error("Invalid control response")) }
    })
  })
}

export async function serve(path: string, handle: (method: string, params: Record<string, unknown>) => unknown) {
  const parent = dirname(path)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const info = await lstat(parent)
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077)) {
    throw new Error("Control socket requires a private directory owned by you (mode 0700)")
  }
  try {
    const file = await lstat(path)
    if (!file.isSocket() || file.uid !== process.getuid?.()) throw new Error("Refusing to replace a non-socket or another user's socket")
    await new Promise<void>((resolve, reject) => {
      const probe = createConnection(path)
      probe.setTimeout(1000)
      probe.once("connect", () => { probe.destroy(); reject(new Error("Another TUI is already running for this profile/socket")) })
      probe.once("timeout", () => { probe.destroy(); reject(new Error("Existing control socket is unresponsive")) })
      probe.once("error", (e: NodeJS.ErrnoException) => e.code === "ECONNREFUSED" ? resolve() : reject(e))
    })
    await unlink(path)
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e }

  const sockets = new Set<Socket>()
  const server = createServer(socket => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
    socket.on("error", () => socket.destroy())
    socket.setEncoding("utf8")
    socket.setTimeout(75_000, () => socket.destroy())
    let buffer = ""
    let received = false
    socket.on("data", chunk => {
      if (received) return
      buffer += chunk
      if (Buffer.byteLength(buffer) > LIMIT) { socket.destroy(); return }
      const end = buffer.indexOf("\n")
      if (end < 0) return
      received = true // one request per connection; net.Socket handles write backpressure
      void (async () => {
        let id: unknown = null
        try {
          const input = JSON.parse(buffer.slice(0, end))
          if (!input || typeof input.method !== "string" || !Number.isSafeInteger(input.id)) throw new Error("Invalid request")
          id = input.id
          const params = input.params ?? {}
          if (typeof params !== "object" || Array.isArray(params)) throw new Error("Invalid params")
          const result = await handle(input.method, params)
          socket.end(JSON.stringify({ id, ok: true, result: result ?? null }) + "\n")
        } catch (e) {
          socket.end(JSON.stringify({ id, ok: false, error: e instanceof Error ? e.message : "Control error" }) + "\n")
        }
      })()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(path, () => { server.off("error", reject); resolve() })
  })
  await chmod(path, 0o600)
  return { async stop() {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()))
    await unlink(path).catch(() => {})
  } }
}

function string(params: Record<string, unknown>, key: string) {
  const value = params[key]
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty string`)
  return value
}
export function controller(store: Store, focus: () => void = () => {}) {
  // Serialize screen-changing agent requests so overlapping drafts cannot land in another session.
  let pending = Promise.resolve<unknown>(null)
  const handle = async (method: string, params: Record<string, unknown>) => {
    switch (method) {
      case "state": return store.snapshot()
      case "screen": return store.screen()
      case "conversations": return store.state.conversations
      case "messages": return store.state.messages
      case "goto": {
        await store.open(string(params, "session"))
        store.update({ status: "Agent opened a conversation" })
        return store.snapshot()
      }
      case "draft": {
        if (store.state.readOnly) throw new Error("Read-only mode: agent drafts are disabled")
        const session = string(params, "session")
        const text = string(params, "text")
        if (params.note !== undefined && typeof params.note !== "boolean") throw new Error("note must be boolean")
        if (params.replace !== undefined && typeof params.replace !== "boolean") throw new Error("replace must be boolean")
        const check = () => {
          if (store.state.sending) throw new Error("A send is in progress")
          if (store.state.drafts[session]?.text && params.replace !== true) throw new Error("Draft already exists; use --replace to overwrite it")
        }
        check()
        if (store.state.active?.session_id !== session) await store.open(session)
        if (store.state.active?.session_id !== session) throw new Error("Conversation changed while preparing draft; retry")
        check()
        store.setDraft(text, params.note === true)
        store.update({ status: "Agent draft ready · review and press Enter to send" })
        focus()
        return { session, draft: store.draft(), sent: false }
      }
      case "refresh": await store.refresh(); return store.snapshot()
      default: throw new Error(`Unknown control method: ${method}`)
    }
  }
  return (method: string, params: Record<string, unknown>) => {
    const task = pending.then(() => handle(method, params))
    pending = task.catch(() => {})
    return task
  }
}
