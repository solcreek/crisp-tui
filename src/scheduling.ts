/** Injectable time keeps retry and coalescing tests independent of wall-clock delays. */
export interface Clock {
  now(): number
  after(ms: number, callback: () => void): () => void
}
export const systemClock: Clock = {
  now: Date.now,
  after(ms, callback) {
    const timer = setTimeout(callback, ms)
    return () => clearTimeout(timer)
  },
}
