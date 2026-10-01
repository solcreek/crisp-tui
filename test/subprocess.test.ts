import { afterAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { capture } from "../src/subprocess"
import { runner } from "../src/crispctl"
import { TestClock } from "./helpers/clock"

const scratch = await mkdtemp(join(tmpdir(), "crisp-subprocess-"))
afterAll(() => rm(scratch, { recursive: true, force: true }))

test("capture preserves UTF-8, stderr and exit status, and cancels its deadline", async () => {
  const clock = new TestClock()
  const code = `const b=Buffer.from('こんにちは'); process.stdout.write(b.subarray(0,4));
    setTimeout(()=>{process.stdout.write(b.subarray(4));process.stderr.write('diagnostic');process.exitCode=7},10)`
  const result = await capture(["node", "-e", code], 30_000, process.env, clock)
  expect(result).toEqual({ stdout: "こんにちは", stderr: "diagnostic", code: 7, timedOut: false })
  expect(clock.pending).toBe(0)
})

test("deadline kills a SIGTERM-resistant child and discards partial JSON and private stderr", async () => {
  const ready = join(scratch, "ready"), clock = new TestClock()
  const code = `process.on('SIGTERM',()=>{});process.stdout.write('{}');process.stderr.write('synthetic-secret');
    require('node:fs').writeFileSync(process.env.TEST_READY,String(process.pid));setInterval(()=>{},1000)`
  const task = capture(["node", "-e", code], 30_000, { PATH: process.env.PATH, TEST_READY: ready }, clock)
  try {
    for (let i = 0; i < 100 && !await Bun.file(ready).exists(); i++) await Bun.sleep(10)
    expect(await Bun.file(ready).exists()).toBe(true)
    const pid = Number(await Bun.file(ready).text())
    await clock.advance(30_000)
    expect(await task).toEqual({ stdout: "", stderr: "", code: 1, timedOut: true })
    expect(() => process.kill(pid, 0)).toThrow()
    expect(clock.pending).toBe(0)
  } finally { await clock.advance(30_000); await task }
})

test("runner reports a deadline as a failed operation even if JSON was written", async () => {
  const run = runner([process.execPath, "-e", "console.log('{}');setInterval(()=>{},1000)"], [], process.env, 200)
  await expect(run([])).rejects.toThrow("crispctl timed out")
})
