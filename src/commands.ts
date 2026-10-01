import type { Store } from "./store"

type Params = Record<string, unknown>
interface Command {
  fields: Record<string, "string" | "boolean">
  mode: "snapshot" | "action"
  allowedInReadOnly: boolean
  output: "json" | "text"
  execute: (store: Store, params: Params, focus: () => void) => unknown
}

/** CLI syntax, socket validation, permissions and execution share this registry. */
export const commands: Readonly<Record<string, Command>> = {
  state: { fields: {}, mode: "snapshot", allowedInReadOnly: true, output: "json", execute: store => store.snapshot() },
  screen: { fields: {}, mode: "snapshot", allowedInReadOnly: true, output: "text", execute: store => store.screen() },
  conversations: { fields: {}, mode: "snapshot", allowedInReadOnly: true, output: "json", execute: store => store.state.conversations },
  messages: { fields: {}, mode: "snapshot", allowedInReadOnly: true, output: "json", execute: store => store.state.messages },
  refresh: { fields: {}, mode: "action", allowedInReadOnly: true, output: "json", execute: async store => {
    await store.refresh()
    return store.snapshot()
  } },
  goto: { fields: { session: "string" }, mode: "action", allowedInReadOnly: true, output: "json", execute: async (store, params) => {
    await store.open(params.session as string)
    store.update({ status: "Agent opened a conversation" })
    return store.snapshot()
  } },
  draft: { fields: { session: "string", text: "string", note: "boolean", replace: "boolean" },
    mode: "action", allowedInReadOnly: false, output: "json", execute: async (store, params, focus) => {
      const session = params.session as string
      const check = () => {
        if (store.state.readOnly) throw new Error("Read-only mode: agent drafts are disabled")
        if (store.state.sending) throw new Error("A send is in progress")
        if (store.state.drafts[session]?.text && params.replace !== true) throw new Error("Draft already exists; use --replace to overwrite it")
      }
      check()
      if (store.state.active?.session_id !== session) await store.open(session)
      if (store.state.active?.session_id !== session) throw new Error("Conversation changed while preparing draft; retry")
      check()
      store.setDraft(params.text as string, params.note === true)
      store.update({ status: "Agent draft ready · review and press Enter to send" })
      focus()
      return { session, draft: store.draft(), sent: false }
    } },
}

export const controlHelp = Object.entries(commands).map(([name, command]) =>
  `ctl ${name}${Object.entries(command.fields).map(([field, type]) => type === "string" ? ` ${field.toUpperCase()}` : ` [--${field}]`).join("")}`)

export function validateCommand(method: string, input: unknown) {
  if (!Object.hasOwn(commands, method)) throw new Error(`Unknown control method: ${method}`)
  const command = commands[method]!
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid params")
  const params = input as Params
  for (const key of Object.keys(params)) {
    if (!Object.hasOwn(command.fields, key)) throw new Error(`Unknown ${method} parameter: ${key}`)
  }
  for (const [key, type] of Object.entries(command.fields)) {
    const value = params[key]
    if (type === "string" && (typeof value !== "string" || !value.trim())) throw new Error(`${key} must be a non-empty string`)
    if (type === "boolean" && value !== undefined && typeof value !== "boolean") throw new Error(`${key} must be boolean`)
  }
  return { command, params: { ...params } }
}

export function parseControlCommand(method: string | undefined, args: string[], flags: { note?: boolean; replace?: boolean }) {
  if (!method || !Object.hasOwn(commands, method)) throw new Error(`Usage: ${controlHelp.join("; ")}`)
  const command = commands[method]!
  const positional = Object.entries(command.fields).filter(([, type]) => type === "string").map(([key]) => key)
  if (args.length !== positional.length) throw new Error(`Usage: ${controlHelp.join("; ")}`)
  const params: Params = Object.fromEntries(positional.map((key, i) => [key, args[i]]))
  for (const [key, enabled] of Object.entries({ note: flags.note, replace: flags.replace })) if (enabled) params[key] = true
  return { method, ...validateCommand(method, params) }
}

export function controller(store: Store, focus: () => void = () => {}) {
  let pending = Promise.resolve<unknown>(null)
  return async (method: string, input: Params) => {
    const { command, params } = validateCommand(method, input)
    const execute = () => {
      if (store.state.readOnly && !command.allowedInReadOnly) throw new Error("Read-only mode: agent drafts are disabled")
      return command.execute(store, params, focus)
    }
    // Snapshots remain available while screen-changing actions wait on I/O.
    if (command.mode === "snapshot") return execute()
    const task = pending.then(execute)
    pending = task.catch(() => {})
    return task
  }
}
