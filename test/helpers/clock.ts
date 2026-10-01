import type { Clock } from "../../src/scheduling"

export class TestClock implements Clock {
  private time = 100_000
  private nextId = 0
  private timers = new Map<number, { at: number; callback: () => void }>()
  now = () => this.time
  after(ms: number, callback: () => void) {
    const id = this.nextId++
    this.timers.set(id, { at: this.time + ms, callback })
    return () => { this.timers.delete(id) }
  }
  get pending() { return this.timers.size }
  async flush() { for (let i = 0; i < 40; i++) await Promise.resolve() }
  async advance(ms: number) {
    const end = this.time + ms
    for (;;) {
      const next = [...this.timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      this.time = next[1].at
      this.timers.delete(next[0]); next[1].callback()
      await this.flush()
    }
    this.time = end
    await this.flush()
  }
}
