// Fixed names only: never record argv, paths, identifiers, content, or error text.
const names = [
  "startup.entry", "startup.layout", "startup.credentials", "startup.auth", "startup.ui_import",
  "startup.socket", "startup.renderer", "startup.mount", "startup.first_frame", "startup.ready_frame",
  "client.list", "client.get", "client.messages", "crispctl.parse",
  "subprocess.spawn", "subprocess.first_stdout", "subprocess.first_stderr", "subprocess.total",
  "state.notify", "state.reconcile", "cache.lookup", "cache.store", "details.project",
  "navigation.feedback_frame", "navigation.cached_frame", "navigation.cold_frame", "navigation.fresh_frame",
  "render.frame", "render.native", "render.stdout", "render.state_to_frame", "rtm.authenticate",
] as const
export type MetricName = typeof names[number]
const allowed = new Set<string>(names)
const counterNames = ["cache.hit", "cache.miss", "navigation.superseded"] as const
type Counter = typeof counterNames[number]
interface Samples { count: number; failures: number; totalMs: number; maxMs: number; samples: number[]; next: number }

export class Metrics {
  private timings = new Map<MetricName, Samples>()
  private counters = new Map<Counter, number>()
  constructor(readonly enabled: boolean, readonly now = () => performance.now(), private capacity = 256) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 4096) throw new Error("Invalid metric sample capacity")
  }
  record(name: MetricName, ms: number, failed = false) {
    if (!this.enabled || !allowed.has(name) || !Number.isFinite(ms) || ms < 0) return
    let entry = this.timings.get(name)
    if (!entry) { entry = { count: 0, failures: 0, totalMs: 0, maxMs: 0, samples: [], next: 0 }; this.timings.set(name, entry) }
    entry.count++; entry.failures += Number(failed); entry.totalMs += ms; entry.maxMs = Math.max(entry.maxMs, ms)
    entry.samples[entry.next] = ms; entry.next = (entry.next + 1) % this.capacity
  }
  increment(name: Counter) {
    if (this.enabled && counterNames.includes(name)) this.counters.set(name, (this.counters.get(name) ?? 0) + 1)
  }
  start(name: MetricName) {
    const start = this.enabled ? this.now() : 0
    let ended = false
    return (failed = false) => {
      if (this.enabled && !ended) { ended = true; this.record(name, this.now() - start, failed) }
    }
  }
  async measure<T>(name: MetricName, fn: () => Promise<T>): Promise<T> {
    if (!this.enabled) return fn()
    const end = this.start(name)
    try { const value = await fn(); end(); return value }
    catch (error) { end(true); throw error }
  }
  sync<T>(name: MetricName, fn: () => T): T {
    if (!this.enabled) return fn()
    const end = this.start(name)
    try { const value = fn(); end(); return value }
    catch (error) { end(true); throw error }
  }
  snapshot() {
    const round = (n: number) => Math.round(n * 1000) / 1000
    return { enabled: this.enabled, unit: "ms", sampleCapacity: this.capacity,
      counters: Object.fromEntries(this.counters), timings: Object.fromEntries([...this.timings].map(([name, entry]) => {
        const sorted = [...entry.samples].sort((a, b) => a - b)
        const percentile = (q: number) => round(sorted[Math.ceil(sorted.length * q) - 1]!)
        return [name, { count: entry.count, failures: entry.failures, meanMs: round(entry.totalMs / entry.count),
          maxMs: round(entry.maxMs), samples: sorted.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95) }]
      })) }
  }
}
export const metrics = new Metrics(process.env.CRISP_TUI_PERF === "1")
