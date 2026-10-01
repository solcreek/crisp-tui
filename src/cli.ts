import { loadLayout } from "./layout"
import { parseArgs } from "node:util"
import { command, createClient, runner, CliError } from "./crispctl"
import { demoClient } from "./demo"
import { NotRunning, request, socketPath } from "./control"
import { Store } from "./store"
import { readOnlyClient } from "./readonly"
import { listen } from "./rtm"
import { controlHelp, parseControlCommand } from "./commands"

export const help = `crisp-tui — Crisp inbox for people and agents

  crisp-tui [tui] [--demo] [--read-only] [--profile sandbox] [--website ID] [--config FILE]
${controlHelp.map(line => `  crisp-tui ${line}`).join("\n")}
  crisp-tui cli <crispctl arguments...>
  crisp-tui live --item ITEM [--website ID]    # read-only TUI using 1Password
  crisp-tui check --item ITEM [--website ID]   # bounded read-only connection check

TUI: Ctrl+B toggles details; Tab cycles panes; / searches; Ctrl+N toggles reply/note;
     Ctrl+R refreshes; Ctrl+E resolves/reopens; Ctrl+U marks read;
     [ / ] pages inbox; Enter sends in composer; Ctrl+C quits.
Global control/TUI options: --profile, --website. --poll SECONDS (default 60;
0 disables polling; minimum 30). CRISPCTL_BIN selects the crispctl executable.
Agent drafts are never sent automatically. Direct writes use 'cli reply ...'.
--read-only disables TUI replies, notes, state changes, mark-read and agent drafts.
Exit codes: 0 success, 1 operation error, 2 usage, 3 no running TUI.
`

export function options(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    config: { type: "string" },
    demo: { type: "boolean" }, "read-only": { type: "boolean" }, profile: { type: "string", default: process.env.CRISPCTL_PROFILE || "sandbox" },
    website: { type: "string" }, poll: { type: "string", default: "60" },
    offset: { type: "string" }, limit: { type: "string" }, revision: { type: "string" },
    note: { type: "boolean" }, replace: { type: "boolean" }, help: { type: "boolean", short: "h" },
  } })
  const poll = Number(values.poll)
  if (!Number.isInteger(poll) || (poll !== 0 && poll < 30)) throw new CliError("--poll must be 0 or an integer of at least 30 seconds", 2)
  return { ...values, profile: values.profile!, poll, positionals }
}
export async function main(args: string[]) {
  if (args[0] === "live" || args[0] === "check") {
    const { liveReadonlyMain } = await import("./live-readonly")
    return liveReadonlyMain([...args.slice(1), ...(args[0] === "check" ? ["--check"] : [])])
  }
  if (args[0] === "cli") {
    // Pass argv verbatim; crispctl owns API commands, credentials, JSON and exit codes.
    return await Bun.spawn([...command(), ...args.slice(1)], { env: process.env, stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited
  }
  let opts: ReturnType<typeof options>
  try { opts = options(args) } catch (e) { throw new CliError(e instanceof Error ? e.message : "Invalid arguments", 2) }
  if (opts.help) { console.log(help); return 0 }
  const [mode, verb, ...rest] = opts.positionals
  const path = socketPath(opts.profile, opts.website)
  if (mode === "ctl") {
    if (opts.demo || opts["read-only"] || opts.poll !== 60 || opts.config !== undefined) throw new CliError("--demo, --read-only, --poll and --config are TUI options", 2)
    let parsed: ReturnType<typeof parseControlCommand>
    try { parsed = parseControlCommand(verb, rest, opts) }
    catch (error) { throw new CliError(error instanceof Error ? error.message : "Invalid control arguments", 2) }
    const result = await request(path, parsed.method, parsed.params)
    console.log(parsed.command.output === "text" ? result : JSON.stringify(result))
    return 0
  }
  if ((mode && mode !== "tui") || verb || rest.length || opts.note || opts.replace || opts.offset !== undefined || opts.limit !== undefined || opts.revision !== undefined) throw new CliError("Unknown command or option. Use --help; API commands go after 'cli'.", 2)
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new CliError("The TUI needs an interactive terminal. Use ctl or cli for agent workflows.", 2)
  const layout = await loadLayout(opts.config)
  const readOnly = opts["read-only"] || process.env.CRISPCTL_READ_ONLY === "1"
  let client
  if (opts.demo) client = demoClient()
  else {
    const flags = ["--profile", opts.profile, ...(opts.website ? ["--website", opts.website] : []), ...(readOnly ? ["--read-only"] : [])]
    const prefix = command()
    const run = runner(prefix, flags)
    const auth = await run(["auth", "show"]) as { tier?: string; key?: string; identifier?: string; website_id?: string }
    if (auth.tier !== "website") throw new Error("Configure crispctl with --tier website. This TUI uses website tokens.")
    if (auth.key !== "set" || !auth.identifier || !auth.website_id) throw new Error("Incomplete crispctl website credentials. See README.md.")
    client = createClient(run, `${opts.profile} · website ${auth.website_id}`, listen(prefix, flags))
  }
  await (await import("./tui")).startTui(new Store(readOnly ? readOnlyClient(client) : client), path, opts.poll * 1000, undefined, layout)
  return 0
}
export function exitCode(error: unknown) { return error instanceof NotRunning ? 3 : error instanceof CliError ? error.code : 1 }
