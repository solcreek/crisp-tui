import { expect, test } from "bun:test"
import { credentialProgress } from "../src/startup-progress"
import { TestClock } from "./helpers/clock"

for (const fails of [false, true]) test(`credential progress clears and cancels after ${fails ? "failure" : "success"}`, async () => {
  const clock = new TestClock(), writes: string[] = [], release = Promise.withResolvers<string>()
  const output = { isTTY: true, write: (text: string) => writes.push(text) }
  const result = credentialProgress(() => release.promise, output, clock)
  const settled = result.then(value => ({ value }), error => ({ error: error.message }))
  expect(writes[0]).toContain("Reading 1Password credentials")
  await clock.advance(5000)
  expect(writes.at(-1)).toContain("(5s)")
  if (fails) release.reject(new Error("private failure"))
  else release.resolve("private credential")
  expect(await settled).toEqual(fails ? { error: "private failure" } : { value: "private credential" })
  expect(writes.at(-1)).toBe("\r\x1b[2K")
  expect(writes.join("")).not.toContain("private")
  expect(clock.pending).toBe(0)
  const count = writes.length
  await clock.advance(60_000)
  expect(writes).toHaveLength(count)
})

test("redirected output has no progress text or timers", async () => {
  const clock = new TestClock(), writes: string[] = []
  expect(await credentialProgress(async () => 42, { write: text => writes.push(text) }, clock)).toBe(42)
  expect(writes).toEqual([])
  expect(clock.pending).toBe(0)
})

test("a synchronous credential failure also cleans up progress", async () => {
  const clock = new TestClock(), writes: string[] = []
  await expect(credentialProgress(() => { throw new Error("failed") }, { isTTY: true, write: text => writes.push(text) }, clock)).rejects.toThrow("failed")
  expect(clock.pending).toBe(0)
  expect(writes.at(-1)).toBe("\r\x1b[2K")
})
