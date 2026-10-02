import { afterEach, expect, test } from "bun:test"
import { ImageRenderable, type BaseRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createSignal, Show } from "solid-js"
import { ImagePreviews } from "../src/images"
import { MessageBody } from "../src/ui/MessageBody"
import { imageSize } from "../src/ui/ImageAttachment"
import { App } from "../src/ui/App"
import { Store } from "../src/store"
import { demoClient } from "../src/demo"
import { testPng } from "./fixtures/image"

const url = "https://storage.crisp.chat/users/upload/demo.png"
const message = { type: "file", content: { name: "demo.png", type: "image/png", url } }
let ui: Awaited<ReturnType<typeof testRender>> | undefined
let loader: ImagePreviews | undefined
afterEach(() => { ui?.renderer.destroy(); ui = undefined; loader?.dispose(); loader = undefined })
async function frame(check: (value: string) => boolean) {
  let output = ""
  for (let i = 0; i < 50; i++) {
    await Bun.sleep(10); await ui!.renderOnce(); output = ui!.captureCharFrame()
    if (check(output)) return output
  }
  expect(check(output)).toBe(true)
  return output
}
function images(root: BaseRenderable): ImageRenderable[] {
  return [...(root instanceof ImageRenderable ? [root] : []), ...root.getChildren().flatMap(images)]
}

test("image size preserves aspect and fits narrow / short panes", () => {
  expect(imageSize(800, 400, 60, 40)).toEqual({ width: 60, height: 15 })
  expect(imageSize(400, 800, 60, 20)).toEqual({ width: 9, height: 9 })
  expect(imageSize(800, 400, 1, 1)).toEqual({ width: 1, height: 1 })
})

test("image attachment renders real pixels with a block fallback and resizes with its pane", async () => {
  loader = new ImagePreviews(async () => new Response(testPng(800, 400)))
  ui = await testRender(() => <MessageBody message={message} previews={loader} rows={40} />, { width: 80, height: 40 })
  const output = await frame(value => /[█▀▄]/.test(value))
  expect(output).toContain("[demo.png]")
  const image = images(ui.renderer.root)[0]!
  expect(image.effectiveProtocol).toBe("blocks")
  expect(image.image?.width).toBe(800)
  expect(image.width).toBeLessThanOrEqual(80)
  ui.resize(30, 40)
  await frame(() => image.width <= 30)
  expect(image.width).toBeLessThanOrEqual(30)
  expect(image.height).toBeLessThanOrEqual(18)
})

test("failed and unsupported previews keep the attachment link", async () => {
  let calls = 0
  loader = new ImagePreviews(async () => { calls++; return new Response("invalid pixels") })
  ui = await testRender(() => <box flexDirection="column">
    <MessageBody message={message} previews={loader} />
    <MessageBody message={{ ...message, content: { ...message.content, url: "https://example.com/other.png" } }} previews={loader} />
  </box>, { width: 100, height: 20 })
  const output = await frame(value => value.includes("Preview unavailable"))
  expect(output).toContain(url)
  expect(output).toContain("https://example.com/other.png")
  expect(images(ui.renderer.root)).toHaveLength(0)
  expect(calls).toBe(1)
})

test("unmount aborts a pending preview without updating the disposed UI", async () => {
  let aborted = false, fetching = false
  loader = new ImagePreviews(async (_, init) => {
    fetching = true
    return new Response(new ReadableStream({ start(controller) {
      init.signal!.addEventListener("abort", () => { aborted = true; controller.error(new Error("aborted")) }, { once: true })
    } }))
  })
  const [shown, setShown] = createSignal(true)
  ui = await testRender(() => <Show when={shown()}><MessageBody message={message} previews={loader} /></Show>, { width: 100, height: 20 })
  await frame(() => fetching)
  setShown(false)
  await frame(() => aborted)
  expect(aborted).toBe(true)
  expect(ui.captureCharFrame()).not.toContain("Preview unavailable")
})

test("slow image does not delay text, store readiness or conversation navigation", async () => {
  const client = demoClient(), original = client.messages
  client.messages = async session => session === "session_demo_1"
    ? [...await original(session), message] : original(session)
  let fetching = false, aborted = false
  loader = new ImagePreviews(async (_, init) => {
    fetching = true
    return new Response(new ReadableStream({ start(controller) {
      init.signal!.addEventListener("abort", () => { aborted = true; controller.error(new Error("aborted")) }, { once: true })
    } }))
  })
  const store = new Store(client)
  await store.refresh()
  ui = await testRender(() => <App store={store} previews={loader} />, { width: 160, height: 45 })
  const first = await frame(value => fetching && value.includes("Loading image…"))
  expect(first).toContain("Can you help me find my invoice?")
  expect(store.state.initialReadComplete).toBe(true)
  await store.open("session_demo_2")
  await frame(value => value.includes("How do I invite my teammates?") && !value.includes("Loading image…"))
  expect(aborted).toBe(true)
})

test("offscreen attachments wait until scrolled into view", async () => {
  let calls = 0
  loader = new ImagePreviews(async () => { calls++; return new Response(testPng()) })
  let scroll: import("@opentui/core").ScrollBoxRenderable | undefined
  ui = await testRender(() => <scrollbox ref={scroll} height={10}>
    <box height={40} flexShrink={0}><text>Earlier messages</text></box>
    <MessageBody message={message} previews={loader} />
  </scrollbox>, { width: 100, height: 12 })
  await frame(value => value.includes("Earlier messages"))
  expect(calls).toBe(0)
  scroll!.scrollTo(40)
  await frame(value => /[█▀▄]/.test(value))
  expect(calls).toBe(1)
})
