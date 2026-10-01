import { systemClock, type Clock } from "./scheduling"
import { metrics } from "./performance"

/** Capture a bounded one-shot command; a deadline discards partial output. */
export async function capture(argv: string[], timeoutMs: number, env = process.env, clock: Clock = systemClock, maxOutputBytes = 16 * 1024 * 1024) {
  return metrics.measure("subprocess.total", async () => {
    const started = metrics.now()
    const child = metrics.sync("subprocess.spawn", () => Bun.spawn(argv, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" }))
    const readers = [child.stdout.getReader(), child.stderr.getReader()]
    let timedOut = false, oversized = false
    const stop = () => {
      for (const reader of readers) void reader.cancel().catch(() => {})
      // A hard deadline must also terminate programs that ignore SIGTERM.
      if (child.exitCode === null) child.kill("SIGKILL")
    }
    const cancelTimer = clock.after(timeoutMs, () => { timedOut = true; stop() })
    const read = async (reader: (typeof readers)[number], stream: "subprocess.first_stdout" | "subprocess.first_stderr") => {
      const decoder = new TextDecoder()
      let text = "", bytes = 0
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) return text + decoder.decode()
          if (!bytes && value.byteLength) metrics.record(stream, metrics.now() - started)
          bytes += value.byteLength
          if (bytes > maxOutputBytes) { oversized = true; throw new Error("Output limit exceeded") }
          text += decoder.decode(value, { stream: true })
        }
      } finally { reader.releaseLock() }
    }
    try {
      const [stdout, stderr, code] = await Promise.all([read(readers[0]!, "subprocess.first_stdout"), read(readers[1]!, "subprocess.first_stderr"), child.exited])
      return timedOut ? { stdout: "", stderr: "", code: 1, timedOut } : { stdout, stderr, code, timedOut }
    } catch {
      stop()
      await child.exited
      throw new Error(oversized ? "Subprocess output exceeded its size limit; refresh before retrying a write" : "Subprocess output could not be read")
    } finally { cancelTimer() }
  })
}
