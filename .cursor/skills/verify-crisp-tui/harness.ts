#!/usr/bin/env bun
// Command contract: SKILL.md in this directory.
import { spawn } from "node:child_process"
import { closeSync, existsSync, openSync } from "node:fs"
import { appendFileSync } from "node:fs"
import { chmod, lstat, mkdir, readdir, rename, rm } from "node:fs/promises"
import { createConnection, createServer, type Server, type Socket } from "node:net"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const DEMO_SOURCE = "DEMO · local only"
const PROTOCOL = 1
const COLS = 100
const ROWS = 30
const READY_MS = 10_000
const WAIT_MS = 5_000
// OpenTUI's stdin parser holds a lone ESC for 20ms in case a CSI sequence
// follows. The UI test waits 50ms so the next byte is not read as Alt.
const ESC_SETTLE_MS = 50

class CtlTimeout extends Error {
  constructor(timeoutMs: number) {
    super(`ctl timed out after ${timeoutMs}ms`)
    this.name = "CtlTimeout"
  }
}

const KEYS: Record<string, string> = {
  enter: "\r",
  tab: "\t",
  esc: "\x1b",
  up: "\x1b[A",
  down: "\x1b[B",
  slash: "/",
  prev: "[",
  next: "]",
  j: "j",
  k: "k",
  backspace: "\x7f",
  "ctrl-e": "\x05",
  "ctrl-j": "\n",
  "ctrl-n": "\x0e",
  "ctrl-r": "\x12",
  "ctrl-u": "\x15",
}

interface Meta {
  runId: string
  repo: string
  supervisePid: number
  tuiPid: number
  superviseCommand: string
  superviseLstart: string
  tuiCommand: string
  tuiLstart: string
  startedAt: string
}

interface Parsed {
  command?: string
  positionals: string[]
  rest: string[]
  run?: string
  action?: string
  repeat?: number
}

function fail(message: string, code = 1): never {
  process.stderr.write(JSON.stringify({ ok: false, error: message }) + "\n")
  process.exit(code)
}

function emit(value: unknown, code = 0): never {
  process.stdout.write(JSON.stringify(value) + "\n")
  process.exit(code)
}

async function findRepo(start: string) {
  let dir = start
  for (let i = 0; i < 8; i++) {
    const pkgPath = join(dir, "package.json")
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(await Bun.file(pkgPath).text()) as { name?: string }
      if (pkg.name === "crisp-tui") return dir
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error("harness.ts is not inside a crisp-tui checkout")
}

function paths(runId: string) {
  const dir = join("/tmp/crisp-tui-verify", runId)
  return {
    dir,
    socket: join(dir, "control.sock"),
    harnessSock: join(dir, "harness.sock"),
    ptyLog: join(dir, "pty.log"),
    meta: join(dir, "meta.json"),
    supervisorLog: join(dir, "supervisor.log"),
    evidence: join(import.meta.dir, "evidence", runId),
  }
}

function assertRunId(id: string) {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) throw new Error("Run id must match ^[a-z0-9][a-z0-9-]{0,39}$")
  return id
}

function parseArgv(argv: string[]): Parsed {
  const positionals: string[] = []
  const rest: string[] = []
  let run: string | undefined
  let action: string | undefined
  let repeat: number | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--") {
      rest.push(...argv.slice(i + 1))
      break
    }
    if (arg === "--run" || arg === "--action" || arg === "--repeat") {
      const value = argv[++i]
      if (value === undefined) throw new Error(`${arg} needs a value`)
      if (arg === "--run") run = value
      else if (arg === "--action") action = value
      else {
        const n = Number(value)
        if (!Number.isInteger(n) || n < 1 || n > 50) throw new Error("--repeat must be an integer from 1 to 50")
        repeat = n
      }
      continue
    }
    if (arg.startsWith("--")) throw new Error(`Unknown option ${arg}`)
    positionals.push(arg)
  }
  return { command: positionals[0], positionals, rest, run, action, repeat }
}

function resolveRun(parsed: Parsed) {
  const run = parsed.run || process.env.CRISP_TUI_VERIFY_RUN || ""
  if (!run) throw new Error("Set CRISP_TUI_VERIFY_RUN or pass --run")
  return assertRunId(run)
}

async function psField(pid: number, field: "command" | "lstart") {
  const proc = Bun.spawn(["ps", "-ww", "-p", String(pid), "-o", `${field}=`], { stdout: "pipe", stderr: "pipe" })
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  if (code !== 0) return null
  const text = out.trim()
  return text || null
}

async function psEnv(pid: number) {
  const proc = Bun.spawn(["ps", "eww", "-p", String(pid)], { stdout: "pipe", stderr: "pipe" })
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  if (code !== 0) return null
  return out
}

async function waitPs(pid: number, field: "command" | "lstart") {
  const end = Date.now() + 2_000
  while (Date.now() < end) {
    const value = await psField(pid, field)
    if (value) return value
    await Bun.sleep(30)
  }
  throw new Error(`ps did not see pid ${pid}`)
}

function stringEnv(overrides: Record<string, string | undefined>) {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  return env
}

async function readMeta(runId: string): Promise<Meta> {
  const path = paths(runId).meta
  if (!existsSync(path)) throw new Error("Verification supervisor has not written meta.json")
  const meta = JSON.parse(await Bun.file(path).text()) as Meta
  if (meta.runId !== runId) throw new Error("meta.json run id does not match")
  return meta
}

async function writeMeta(meta: Meta) {
  const path = paths(meta.runId).meta
  const tmp = `${path}.tmp`
  await Bun.write(tmp, JSON.stringify(meta, null, 2) + "\n")
  await rename(tmp, path)
}

async function runCtl(runId: string, args: string[], timeoutMs?: number) {
  const repo = await findRepo(import.meta.dir)
  const proc = Bun.spawn([process.execPath, join(repo, "src/index.ts"), "ctl", ...args], {
    cwd: repo,
    env: stringEnv({ CRISP_TUI_SOCKET: paths(runId).socket }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const finished = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).then(([stdout, stderr, code]) => ({ code, stdout, stderr }))
  if (timeoutMs === undefined) return finished
  let timer: ReturnType<typeof setTimeout> | undefined
  const limited = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      proc.kill("SIGKILL")
      reject(new CtlTimeout(timeoutMs))
    }, Math.max(1, timeoutMs))
  })
  try {
    return await Promise.race([finished, limited])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function record(runId: string, file: string, entry: unknown) {
  const dir = paths(runId).evidence
  await mkdir(dir, { recursive: true })
  appendFileSync(join(dir, file), JSON.stringify(entry) + "\n")
}

function rpc(sockPath: string, payload: unknown, timeout: number) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = createConnection(sockPath)
    let buffer = ""
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error("Harness request timed out"))
    }, timeout)
    const finish = (error?: Error, value?: Record<string, unknown>) => {
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolve(value!)
    }
    socket.setEncoding("utf8")
    socket.on("connect", () => socket.write(JSON.stringify(payload) + "\n"))
    socket.on("error", error => finish(error))
    socket.on("data", chunk => {
      buffer += chunk
      const end = buffer.indexOf("\n")
      if (end < 0) return
      try {
        const reply = JSON.parse(buffer.slice(0, end)) as { ok?: boolean; error?: string }
        if (!reply.ok) finish(new Error(reply.error || "Harness request failed"))
        else finish(undefined, reply)
      } catch (error) {
        finish(error instanceof Error ? error : new Error("Invalid harness response"))
      }
    })
  })
}

async function assess(runId: string, timeoutMs = WAIT_MS) {
  const repo = await findRepo(import.meta.dir)
  const pkg = JSON.parse(await Bun.file(join(repo, "package.json")).text()) as { version?: string }
  const expected = paths(runId)
  const meta = await readMeta(runId)
  if (meta.repo !== repo) throw new Error(`meta repo ${meta.repo} is not this checkout`)
  if (!meta.supervisePid || !meta.tuiPid) throw new Error("meta.json has no process ids yet")
  const superviseCommand = await psField(meta.supervisePid, "command")
  const superviseLstart = await psField(meta.supervisePid, "lstart")
  if (!superviseCommand || superviseCommand !== meta.superviseCommand || superviseLstart !== meta.superviseLstart) {
    throw new Error("Verification supervisor is not the process this run started")
  }
  const tuiCommand = await psField(meta.tuiPid, "command")
  const tuiLstart = await psField(meta.tuiPid, "lstart")
  if (!tuiCommand || tuiCommand !== meta.tuiCommand || tuiLstart !== meta.tuiLstart) {
    throw new Error("Demo TUI is not the process this run started")
  }
  const indexPath = join(repo, "src/index.ts")
  if (!tuiCommand.includes(indexPath) || !/(^|\s)--demo(\s|$)/.test(tuiCommand) || !/--poll\s+0(?:\s|$)/.test(tuiCommand)) {
    throw new Error("TUI command is not this checkout's demo with --poll 0")
  }
  const env = await psEnv(meta.tuiPid)
  if (!env || !env.includes(`CRISP_TUI_SOCKET=${expected.socket}`)) throw new Error("TUI is not bound to this run's private socket")
  if (env.includes("CRISPCTL_READ_ONLY=1")) throw new Error("Refusing to drive a read-only instance")
  const stat = await lstat(expected.socket).catch(() => null)
  if (!stat?.isSocket()) throw new Error("Private control socket is not listening")
  if (stat.uid !== process.getuid?.()) throw new Error("Control socket is owned by another user")
  if (stat.mode & 0o077) throw new Error("Control socket is not mode 0600")
  const stateRun = await runCtl(runId, ["state"], timeoutMs)
  if (stateRun.code !== 0) throw new Error((stateRun.stderr || stateRun.stdout).trim() || `ctl state exited ${stateRun.code}`)
  const state = JSON.parse(stateRun.stdout) as {
    source?: string
    protocol?: number
    readOnly?: boolean
    realtime?: string
    conversationLoading?: boolean
    active?: { session_id?: string } | null
    status?: string
    page?: number
    query?: string
  }
  if (state.source !== DEMO_SOURCE) throw new Error(`Refusing to drive source ${JSON.stringify(state.source)}; verification only drives ${DEMO_SOURCE}`)
  if (state.protocol !== PROTOCOL) throw new Error(`Unexpected control protocol ${String(state.protocol)}`)
  if (state.readOnly !== false) throw new Error("Refusing to drive a read-only instance")
  if (state.realtime !== "off") throw new Error("Refusing to drive a live RTM session")
  if (state.conversationLoading) throw new Error("Conversation is still loading")
  if (!state.active?.session_id) throw new Error("Demo inbox has not opened a conversation yet")
  return {
    ok: true,
    runId,
    repo,
    packageVersion: pkg.version,
    supervisePid: meta.supervisePid,
    tuiPid: meta.tuiPid,
    socket: expected.socket,
    evidenceDir: expected.evidence,
    source: state.source,
    protocol: state.protocol,
    readOnly: state.readOnly,
    realtime: state.realtime,
    activeSession: state.active.session_id,
    page: state.page,
    query: state.query,
    status: state.status,
  }
}

async function readPty(runId: string) {
  const path = paths(runId).ptyLog
  if (!existsSync(path)) return ""
  return new TextDecoder().decode(await Bun.file(path).bytes())
}

function encodeKeys(name: string, text: string | undefined, repeat: number) {
  if (name === "type") {
    if (repeat !== 1) throw new Error("--repeat cannot be combined with type")
    if (!text) throw new Error("type requires text after --")
    if (/[^\x20-\x7e]/.test(text)) throw new Error("type only sends printable ASCII; use a key name for control keys")
    return text
  }
  const bytes = KEYS[name]
  if (!bytes) throw new Error(`Unknown key ${name}. Accepted names: ${Object.keys(KEYS).join(", ")}, type`)
  if (text) throw new Error(`Key ${name} does not take text`)
  return bytes.repeat(repeat)
}

async function signalMatching(pid: number, command: string, lstart: string) {
  if (!pid || !command || !lstart) return "skipped"
  const currentCommand = await psField(pid, "command")
  const currentLstart = await psField(pid, "lstart")
  if (!currentCommand || !currentLstart) return "gone"
  if (currentCommand !== command || currentLstart !== lstart) return "reused"
  try { process.kill(pid, "SIGTERM") } catch { return "gone" }
  const end = Date.now() + 1_000
  while (Date.now() < end) {
    if (!await psField(pid, "command")) return "terminated"
    await Bun.sleep(50)
  }
  const againCommand = await psField(pid, "command")
  const againLstart = await psField(pid, "lstart")
  if (againCommand === command && againLstart === lstart) {
    try { process.kill(pid, "SIGKILL") } catch { /* already exited */ }
    return "killed"
  }
  return "reused"
}

async function cleanupRun(runId: string) {
  assertRunId(runId)
  const expected = paths(runId)
  let meta: Meta | null = null
  try { meta = await readMeta(runId) } catch { /* already gone, or not started */ }
  let shutdown = "not-running"
  if (existsSync(expected.harnessSock)) {
    try {
      await rpc(expected.harnessSock, { cmd: "shutdown" }, 6_000)
      shutdown = "socket"
    } catch (error) {
      shutdown = error instanceof Error ? error.message : "shutdown failed"
    }
  }
  const supervise = meta ? await signalMatching(meta.supervisePid, meta.superviseCommand, meta.superviseLstart) : "gone"
  const tui = meta ? await signalMatching(meta.tuiPid, meta.tuiCommand, meta.tuiLstart) : "gone"
  await rm(expected.dir, { recursive: true, force: true })
  return {
    ok: true,
    runId,
    shutdown,
    supervise,
    tui,
    runDirRemoved: !existsSync(expected.dir),
    evidenceDir: expected.evidence,
    evidenceExists: existsSync(expected.evidence),
  }
}

function listen(server: Server, sockPath: string) {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(sockPath, () => {
      server.off("error", reject)
      resolve()
    })
  })
}

async function supervise(runId: string) {
  assertRunId(runId)
  const repo = await findRepo(import.meta.dir)
  const expected = paths(runId)
  await mkdir(expected.dir, { recursive: true, mode: 0o700 })
  await chmod(expected.dir, 0o700)
  await mkdir(expected.evidence, { recursive: true })
  const meta: Meta = {
    runId,
    repo,
    supervisePid: process.pid,
    tuiPid: 0,
    superviseCommand: "",
    superviseLstart: "",
    tuiCommand: "",
    tuiLstart: "",
    startedAt: new Date().toISOString(),
  }
  meta.superviseCommand = await waitPs(process.pid, "command")
  meta.superviseLstart = await waitPs(process.pid, "lstart")
  await writeMeta(meta)

  const child = Bun.spawn([process.execPath, join(repo, "src/index.ts"), "--demo", "--poll", "0"], {
    cwd: repo,
    env: stringEnv({
      CRISP_TUI_SOCKET: expected.socket,
      TERM: "xterm-256color",
      COLUMNS: String(COLS),
      LINES: String(ROWS),
      CRISPCTL_READ_ONLY: undefined,
    }),
    terminal: {
      cols: COLS,
      rows: ROWS,
      name: "xterm-256color",
      data: (_terminal, data) => appendFileSync(expected.ptyLog, Buffer.from(data)),
    },
  })
  const terminal = child.terminal
  if (!terminal) throw new Error("PTY was not created")
  meta.tuiPid = child.pid
  meta.tuiCommand = await waitPs(child.pid, "command")
  meta.tuiLstart = await waitPs(child.pid, "lstart")
  await writeMeta(meta)

  let shuttingDown = false
  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    try {
      if (!terminal.closed) terminal.write("\x03")
      const exited = await Promise.race([child.exited.then(() => "exited" as const), Bun.sleep(3_000).then(() => "timeout" as const)])
      if (exited === "timeout" && child.exitCode === null) {
        child.kill("SIGTERM")
        const killed = await Promise.race([child.exited.then(() => "exited" as const), Bun.sleep(1_000).then(() => "timeout" as const)])
        if (killed === "timeout" && child.exitCode === null) child.kill("SIGKILL")
        await child.exited
      }
    } finally {
      if (!terminal.closed) terminal.close()
    }
  }

  let keyChain = Promise.resolve()
  const server = createServer(connection => handleClient(connection, async request => {
    if (request.cmd === "ping") return { ok: true }
    if (request.cmd === "shutdown") {
      await shutdown()
      return { ok: true, exit: true }
    }
    if (request.cmd === "keys") {
      if (shuttingDown || child.exitCode !== null) throw new Error("TUI is not running")
      const name = String(request.name ?? "")
      const text = request.text === undefined ? undefined : String(request.text)
      const repeat = Number(request.repeat ?? 1)
      const bytes = encodeKeys(name, text, repeat)
      keyChain = keyChain.then(async () => {
        if (terminal.closed) return
        // A lone ESC is not a key until the parser's settle window ends.
        // Returning earlier lets the next key join it and become Alt.
        if (name === "esc") {
          for (let i = 0; i < repeat; i++) {
            if (terminal.closed) return
            terminal.write("\x1b")
            await Bun.sleep(ESC_SETTLE_MS)
          }
          return
        }
        terminal.write(bytes)
      })
      await keyChain
      return { ok: true }
    }
    throw new Error("Unknown harness command")
  }, () => server.close(() => process.exit(0))))
  await listen(server, expected.harnessSock)
  await chmod(expected.harnessSock, 0o600)
  console.error(`supervise ${runId} tui ${child.pid}`)
  void child.exited.then(() => {
    if (shuttingDown) return
    server.close()
    process.exit(0)
  })
  const stop = () => { void shutdown().finally(() => process.exit(0)) }
  process.on("SIGTERM", stop)
  process.on("SIGINT", stop)
}

function handleClient(connection: Socket, handle: (request: Record<string, unknown>) => Promise<{ exit?: boolean }>, onExit: () => void) {
  connection.setEncoding("utf8")
  let buffer = ""
  let taken = false
  connection.on("error", () => connection.destroy())
  connection.on("data", chunk => {
    if (taken) return
    buffer += chunk
    const end = buffer.indexOf("\n")
    if (end < 0) return
    taken = true
    void (async () => {
      let response: { ok: boolean; error?: string; exit?: boolean } = { ok: false, error: "Control error" }
      try {
        const request = JSON.parse(buffer.slice(0, end)) as Record<string, unknown>
        response = { ok: true, ...await handle(request) }
      } catch (error) {
        response = { ok: false, error: error instanceof Error ? error.message : "Control error" }
      }
      const exit = response.exit === true && response.ok
      connection.end(JSON.stringify(response) + "\n", () => {
        if (exit) onExit()
      })
    })()
  })
}

async function assertFreshEvidence(runId: string) {
  const dir = paths(runId).evidence
  if (!existsSync(dir)) return
  if ((await readdir(dir)).length > 0) {
    throw new Error(`Evidence for ${runId} already exists at ${dir}. Choose another --run. Cleanup keeps that directory so a later launch cannot append to it.`)
  }
}

async function launch(runId: string) {
  assertRunId(runId)
  const repo = await findRepo(import.meta.dir)
  const index = join(repo, "src/index.ts")
  if (!existsSync(index)) throw new Error(`Missing ${index}`)
  if (!existsSync(join(repo, "node_modules"))) throw new Error("node_modules is missing. Run bun install in the crisp-tui checkout, then launch again.")
  const expected = paths(runId)
  if (existsSync(expected.dir)) throw new Error(`Run directory already exists for ${runId}. Run cleanup or choose another --run.`)
  await assertFreshEvidence(runId)
  await mkdir("/tmp/crisp-tui-verify", { recursive: true, mode: 0o700 })
  await chmod("/tmp/crisp-tui-verify", 0o700)
  await mkdir(expected.dir, { recursive: true, mode: 0o700 })
  await chmod(expected.dir, 0o700)
  await mkdir(expected.evidence, { recursive: true })
  const logFd = openSync(expected.supervisorLog, "a")
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "supervise", runId], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: repo,
    env: process.env,
  })
  child.unref()
  closeSync(logFd)
  try {
    const end = Date.now() + READY_MS
    let last = "supervisor did not become ready"
    while (Date.now() < end) {
      try {
        return await assess(runId, Math.max(1, end - Date.now()))
      } catch (error) {
        last = error instanceof Error ? error.message : String(error)
      }
      await Bun.sleep(50)
    }
    throw new Error(last)
  } catch (error) {
    const supervisorLog = existsSync(expected.supervisorLog) ? await Bun.file(expected.supervisorLog).text() : ""
    const pty = await readPty(runId).catch(() => "")
    await cleanupRun(runId).catch(() => {})
    const detail = [error instanceof Error ? error.message : String(error), supervisorLog.slice(-800), pty.slice(-800)].filter(Boolean).join("\n")
    throw new Error(detail)
  }
}

async function waitFor(runId: string, kind: string, text: string) {
  if (!text) throw new Error("wait requires the text after --")
  if (!["pty", "screen", "status", "messages"].includes(kind)) throw new Error("wait kind must be pty, screen, status, or messages")
  const end = Date.now() + WAIT_MS
  try {
    await assess(runId, Math.max(1, end - Date.now()))
  } catch (error) {
    if (!(error instanceof CtlTimeout)) throw error
  }
  while (Date.now() < end) {
    let hay = ""
    if (kind === "pty") hay = await readPty(runId)
    else {
      const args = kind === "messages" ? ["messages"] : kind === "screen" ? ["screen"] : ["state"]
      const remaining = end - Date.now()
      if (remaining <= 0) break
      try {
        const result = await runCtl(runId, args, remaining)
        if (result.code === 0) {
          hay = kind === "status" ? (JSON.parse(result.stdout) as { status?: string }).status ?? "" : result.stdout
        }
      } catch (error) {
        if (error instanceof CtlTimeout) break
        throw error
      }
    }
    if (hay.includes(text)) return { ok: true, via: kind, text }
    const pause = Math.min(30, end - Date.now())
    if (pause <= 0) break
    await Bun.sleep(pause)
  }
  throw new Error(`Timed out waiting for ${kind} to include ${JSON.stringify(text)}\n${(await readPty(runId)).slice(-500)}`)
}

async function capture(runId: string, name: string, action: string | undefined) {
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) throw new Error("Capture name must match ^[a-z0-9][a-z0-9-]{0,40}$")
  await assess(runId)
  const dir = join(paths(runId).evidence, name)
  await mkdir(dir, { recursive: true })
  const calls = await Promise.all([
    runCtl(runId, ["state"]),
    runCtl(runId, ["screen"]),
    runCtl(runId, ["messages"]),
    runCtl(runId, ["conversations"]),
  ])
  const failed = calls.find(call => call.code !== 0)
  if (failed) throw new Error((failed.stderr || failed.stdout).trim() || "ctl snapshot failed")
  const [state, screen, messages, conversations] = calls
  await Bun.write(join(dir, "action.txt"), `${action ?? ""}\n`)
  await Bun.write(join(dir, "state.json"), state!.stdout.endsWith("\n") ? state!.stdout : `${state!.stdout}\n`)
  await Bun.write(join(dir, "screen.txt"), screen!.stdout.endsWith("\n") ? screen!.stdout : `${screen!.stdout}\n`)
  await Bun.write(join(dir, "messages.json"), messages!.stdout.endsWith("\n") ? messages!.stdout : `${messages!.stdout}\n`)
  await Bun.write(join(dir, "conversations.json"), conversations!.stdout.endsWith("\n") ? conversations!.stdout : `${conversations!.stdout}\n`)
  await Bun.write(join(dir, "pty.log"), await readPty(runId))
  const parsed = JSON.parse(state!.stdout) as { source?: string; active?: { session_id?: string } | null; status?: string }
  await Bun.write(join(dir, "manifest.json"), JSON.stringify({
    name,
    action: action ?? "",
    runId,
    at: new Date().toISOString(),
    source: parsed.source,
    activeSession: parsed.active?.session_id ?? null,
    status: parsed.status,
  }, null, 2) + "\n")
  return { ok: true, dir }
}

function help() {
  process.stdout.write(`verify-crisp-tui harness

  launch [--run ID]
  doctor [--run ID]
  ctl [--run ID] -- <ctl args>
  keys [--run ID] <name> [--repeat N]
  keys [--run ID] type -- <text>
  wait [--run ID] pty|screen|status|messages -- <text>
  capture [--run ID] <name> [--action TEXT]
  cleanup [--run ID]

The command contract is SKILL.md in this directory.
`)
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv[0] === "supervise") {
    await supervise(assertRunId(argv[1] || ""))
    return
  }
  let parsed: Parsed
  try { parsed = parseArgv(argv) } catch (error) { fail(error instanceof Error ? error.message : "Invalid arguments", 2) }
  if (!parsed!.command || parsed!.command === "help" || parsed!.command === "--help") {
    help()
    return
  }
  try {
    if (parsed!.command === "launch") {
      const runId = parsed!.run || process.env.CRISP_TUI_VERIFY_RUN || `v${Date.now().toString(36)}`
      emit(await launch(assertRunId(runId)))
    }
    if (parsed!.command === "doctor") emit(await assess(resolveRun(parsed!)), 0)
    if (parsed!.command === "cleanup") emit(await cleanupRun(resolveRun(parsed!)))
    if (parsed!.command === "wait") {
      const result = await waitFor(resolveRun(parsed!), parsed!.positionals[1] || "", parsed!.rest.join(" "))
      emit(result)
    }
    if (parsed!.command === "capture") {
      const name = parsed!.positionals[1]
      if (!name) throw new Error("capture requires a name")
      emit(await capture(resolveRun(parsed!), name, parsed!.action))
    }
    if (parsed!.command === "keys") {
      const runId = resolveRun(parsed!)
      const name = parsed!.positionals[1]
      if (!name) throw new Error("keys requires a key name or type")
      const text = name === "type" ? parsed!.rest.join(" ") : undefined
      if (name === "type" && parsed!.rest.length === 0) throw new Error("keys type requires text after --")
      encodeKeys(name, text, parsed!.repeat ?? 1)
      await assess(runId)
      await rpc(paths(runId).harnessSock, { cmd: "keys", name, text, repeat: parsed!.repeat ?? 1 }, 5_000)
      await record(runId, "keys.jsonl", { at: new Date().toISOString(), name, text: text ?? null, repeat: parsed!.repeat ?? 1, code: 0 })
      emit({ ok: true, name, repeat: parsed!.repeat ?? 1 })
    }
    if (parsed!.command === "ctl") {
      const runId = resolveRun(parsed!)
      if (parsed!.rest.length === 0) throw new Error("ctl requires arguments after --")
      await assess(runId)
      const result = await runCtl(runId, parsed!.rest)
      await record(runId, "ctl.jsonl", {
        at: new Date().toISOString(),
        argv: parsed!.rest,
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
      })
      process.stdout.write(result.stdout)
      process.stderr.write(result.stderr)
      process.exit(result.code)
    }
    fail(`Unknown command ${parsed!.command}. Run with help.`, 2)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Verification harness failed"
    if (parsed!.command === "doctor" || parsed!.command === "launch") {
      emit({ ok: false, error: message }, 1)
    }
    fail(message, 1)
  }
}

await main()
