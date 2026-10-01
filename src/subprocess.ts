import { systemClock, type Clock } from "./scheduling"

/** Capture a bounded one-shot command; a deadline discards partial output. */
export async function capture(argv: string[], timeoutMs: number, env = process.env, clock: Clock = systemClock) {
  const child = Bun.spawn(argv, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const readers = [child.stdout.getReader(), child.stderr.getReader()]
  let timedOut = false
  const stop = () => {
    for (const reader of readers) void reader.cancel().catch(() => {})
    // A hard deadline must also terminate programs that ignore SIGTERM.
    if (child.exitCode === null) child.kill("SIGKILL")
  }
  const cancelTimer = clock.after(timeoutMs, () => { timedOut = true; stop() })
  const read = async (reader: (typeof readers)[number]) => {
    const decoder = new TextDecoder()
    let text = ""
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return text + decoder.decode()
        text += decoder.decode(value, { stream: true })
      }
    } finally { reader.releaseLock() }
  }
  try {
    const [stdout, stderr, code] = await Promise.all([read(readers[0]!), read(readers[1]!), child.exited])
    return timedOut ? { stdout: "", stderr: "", code: 1, timedOut } : { stdout, stderr, code, timedOut }
  } catch {
    stop()
    await child.exited
    throw new Error("Subprocess output could not be read")
  } finally { cancelTimer() }
}
