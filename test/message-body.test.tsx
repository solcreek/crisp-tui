import { afterEach, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { MessageBody } from "../src/ui/MessageBody"

let ui: Awaited<ReturnType<typeof testRender>> | undefined
afterEach(() => { ui?.renderer.destroy(); ui = undefined })
async function frame(content: string) {
  ui = await testRender(() => <MessageBody message={{ type: "text", content }} />, { width: 80, height: 25 })
  for (let i = 0; i < 2; i++) { await Bun.sleep(20); await ui.renderOnce() }
  return ui.captureCharFrame()
}

test("Crisp escaped numbered lines display punctuation without the escape", async () => {
  const content = "1\\. Open settings\n2\\. Choose Team\n3\\. Invite a teammate"
  const output = await frame(content)
  for (const line of ["1. Open settings", "2. Choose Team", "3. Invite a teammate"]) expect(output).toContain(line)
  expect(output).not.toContain("\\.")
})

test("Markdown formatting conceals markers while code keeps literal backslashes", async () => {
  const output = await frame("**Important** and `1\\.`\n\n```text\n2\\. literal code\n```\n\nC:\\Users\\demo")
  expect(output).toContain("Important")
  expect(output).not.toContain("**Important**")
  expect(output).toContain("1\\.")
  expect(output).toContain("2\\. literal code")
  expect(output).toContain("C:\\Users\\demo")
})

test("plain chat preserves newlines and strips terminal controls", async () => {
  const output = await frame("Hello\nworld\x1b[2J")
  expect(output).toContain("Hello")
  expect(output).toContain("world")
  expect(output).not.toContain("\x1b")
})
