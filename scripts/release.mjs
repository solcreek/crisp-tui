import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

/** Publish immutable artifacts; retry registry reads, never ambiguous writes. */
export async function publishRelease(natives, launcher, version, {
  publish, fetch: read = globalThis.fetch, now = Date.now, sleep = delay,
  timeoutMs = 20 * 60_000, intervalMs = 15_000, log = console.log,
}) {
  const deadline = now() + timeoutMs
  const remaining = () => {
    const ms = deadline - now()
    assert(ms > 0, 'npm processing timed out; check registry state before retrying')
    return ms
  }
  async function pause(ms = intervalMs) { await sleep(Math.min(ms, remaining())) }
  async function visible(item) {
    for (;;) {
      let response
      try {
        response = await read(`https://registry.npmjs.org/${item.name}/${version}`, {
          signal: AbortSignal.timeout(Math.min(30_000, remaining())),
        })
      } catch (error) {
        // Transport failures are safe to retry because this operation only reads metadata.
        remaining()
        await pause()
        continue
      }
      if (response.status === 429 || response.status >= 500) {
        const retry = response.headers.get('retry-after')
        const seconds = retry === null ? NaN : Number(retry)
        const wait = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retry ?? '') - now()
        await pause(Number.isFinite(wait) ? Math.max(intervalMs, wait) : intervalMs)
        continue
      }
      if (response.status === 404) return false
      assert(response.ok, `Registry lookup failed for ${item.name}: ${response.status}`)
      const published = await response.json()
      assert.equal(published.dist.integrity, item.integrity, `${item.name}@${version} already exists with different contents`)
      return true
    }
  }
  async function waitForRegistry(items) {
    const pending = new Set(items)
    while (pending.size) {
      remaining()
      for (const item of pending) if (await visible(item)) {
        log(`${item.name}@${version} available; integrity verified`)
        pending.delete(item)
      }
      if (pending.size) await pause()
    }
  }
  // Detect conflicts anywhere in the release before performing the first write.
  const existing = new Set()
  for (const item of [...natives, launcher]) if (await visible(item)) existing.add(item)
  async function publishMissing(item) {
    remaining()
    if (existing.has(item)) log(`${item.name}@${version} already published with matching integrity`)
    else await publish(item)
  }
  for (const item of natives) await publishMissing(item)
  await waitForRegistry(natives)
  await publishMissing(launcher)
  await waitForRegistry([launcher])
}
