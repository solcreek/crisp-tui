import { systemClock, type Clock } from "./scheduling"

interface ProgressOutput { isTTY?: boolean; write(text: string): unknown }

/** Keep the credential wait visible; the signal cancels feedback, not the read. */
export async function credentialProgress<T>(action: () => Promise<T>, output: ProgressOutput = process.stderr, clock: Clock = systemClock, signal?: AbortSignal): Promise<T> {
  if (!output.isTTY || signal?.aborted) return action()
  const started = clock.now()
  let cancel: (() => void) | undefined
  let stopped = false
  const clear = () => {
    if (stopped) return
    stopped = true
    cancel?.()
    output.write("\r\x1b[2K")
  }
  const draw = () => {
    output.write(`\r\x1b[2KReading 1Password credentials… authorize op if prompted (${Math.floor((clock.now() - started) / 1000)}s)`)
    cancel = clock.after(1000, draw)
  }
  draw()
  signal?.addEventListener("abort", clear, { once: true })
  try { return await action() }
  finally { signal?.removeEventListener("abort", clear); clear() }
}
