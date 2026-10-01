import { systemClock, type Clock } from "./scheduling"

interface ProgressOutput { isTTY?: boolean; write(text: string): unknown }

/** Keep the pre-render credential wait visible without contaminating JSON output. */
export async function credentialProgress<T>(action: () => Promise<T>, output: ProgressOutput = process.stderr, clock: Clock = systemClock): Promise<T> {
  if (!output.isTTY) return action()
  const started = clock.now()
  let cancel: (() => void) | undefined
  const draw = () => {
    output.write(`\r\x1b[2KReading 1Password credentials… authorize op if prompted (${Math.floor((clock.now() - started) / 1000)}s)`)
    cancel = clock.after(1000, draw)
  }
  draw()
  try { return await action() }
  finally { cancel?.(); output.write("\r\x1b[2K") }
}
