import { expect, test } from "bun:test"
import { imageAttachment, imageLimits, ImagePreviews, previewUrl } from "../src/images"
import { testPng } from "./fixtures/image"

const url = "https://storage.crisp.chat/users/upload/image.png"
const signal = () => new AbortController().signal
const png = testPng()

test("previews recognize only supported images on official HTTPS attachment hosts", () => {
  expect(imageAttachment({ type: "file", content: { name: "image.png", url } })).toBe(url)
  expect(imageAttachment({ type: "animation", content: { type: "image/GIF; charset=binary", url } })).toBe(url)
  expect(imageAttachment({ type: "file", content: { name: "IMAGE.JPEG", url } })).toBe(url)
  expect(previewUrl("https://image.crisp.chat/avatar.png")).toBe("https://image.crisp.chat/avatar.png")
  for (const bad of ["http://storage.crisp.chat/x", "https://storage.crisp.chat.evil/x", "https://localhost/x", "file:///tmp/x", "data:image/png,x", "not a url", "https://user:pass@storage.crisp.chat/x", "https://storage.crisp.chat:8443/x"]) {
    expect(previewUrl(bad)).toBeUndefined()
  }
  for (const message of [
    { type: "text", content: { type: "image/png", url } },
    { type: "file", content: { type: "application/pdf", name: "fake.png", url } },
    { type: "file", content: { type: "image/svg+xml", url } },
    { type: "file", content: { type: "image/png" } },
    { type: "file", content: { name: "report.pdf", url } },
    { type: "file", content: null }, { content: "hello" },
  ]) expect(imageAttachment(message)).toBeUndefined()
})

test("anonymous GET caches bytes and returns independently owned, bounded previews", async () => {
  let calls = 0
  const previews = new ImagePreviews(async (target, init) => {
    calls++; expect(target).toBe(url)
    expect(init.method).toBe("GET"); expect(init.credentials).toBe("omit"); expect(init.redirect).toBe("manual")
    expect(new Headers(init.headers).has("authorization")).toBe(false)
    return new Response(testPng(2048, 512))
  })
  try {
    const first = await previews.load(url, signal())
    expect(first.width).toBe(1024); expect(first.height).toBe(256)
    first.dispose()
    const second = await previews.load(url, signal())
    expect(second.width).toBe(1024); second.dispose()
    expect(calls).toBe(1)
  } finally { previews.dispose() }
})

test("redirects are revalidated before fetching and loops are bounded", async () => {
  let calls = 0
  const previews = new ImagePreviews(async (_, init) => {
    calls++; expect(init.redirect).toBe("manual")
    return calls === 1 ? new Response(null, { status: 302, headers: { location: "https://image.crisp.chat/image.png" } }) : new Response(png)
  })
  const image = await previews.load(url, signal()); image.dispose(); previews.dispose()
  expect(calls).toBe(2)
  for (const location of ["http://127.0.0.1/secret", "https://example.com/x", "https://user@storage.crisp.chat/x", null, "/loop"]) {
    let attempts = 0
    const loader = new ImagePreviews(async () => {
      attempts++; return new Response(null, { status: 302, headers: location ? { location } : {} })
    })
    await expect(loader.load(url, signal())).rejects.toThrow()
    expect(attempts).toBe(location === "/loop" ? 4 : 1)
    loader.dispose()
  }
})

test("invalid, failed and oversized images fail without caching", async () => {
  for (const response of [
    () => new Response("offline", { status: 404 }),
    () => new Response(null, { status: 204 }),
    () => new Response(png, { headers: { "content-length": String(imageLimits.bytes + 1) } }),
    () => new Response(new Uint8Array(imageLimits.bytes + 1)),
    () => new Response("not an image"),
    () => new Response(testPng(1, 1, 5000, 5000)),
  ]) {
    let calls = 0
    const loader = new ImagePreviews(async () => { calls++; return response() })
    await expect(loader.load(url, signal())).rejects.toThrow()
    await expect(loader.load(url, signal())).rejects.toThrow()
    expect(calls).toBe(2); loader.dispose()
  }
  let fetched = false
  const loader = new ImagePreviews(async () => { fetched = true; throw new Error("offline") })
  await expect(loader.load("https://example.com/x", signal())).rejects.toThrow("Unsupported image host")
  expect(fetched).toBe(false)
  await expect(loader.load(url, signal())).rejects.toThrow("offline")
  loader.dispose()
})

test("timeouts and conversation cancellation interrupt streaming bodies", async () => {
  for (const cancel of [false, true]) {
    let cancelled = false
    const controller = new AbortController()
    const loader = new ImagePreviews(async () => new Response(new ReadableStream({
      start(stream) { stream.enqueue(png.subarray(0, 8)) },
      cancel() { cancelled = true },
    })), cancel ? 1000 : 20)
    const pending = loader.load(url, controller.signal)
    if (cancel) { await Bun.sleep(5); controller.abort() }
    await expect(pending).rejects.toThrow()
    expect(cancelled).toBe(true); loader.dispose()
  }
})

test("at most two downloads run; queued cancellation and disposal release work", async () => {
  let calls = 0
  const loader = new ImagePreviews(async (_, init) => {
    calls++
    return new Response(new ReadableStream({ start(controller) {
      init.signal!.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true })
    } }))
  })
  const aborted = new AbortController(); aborted.abort()
  await expect(loader.load(url, aborted.signal)).rejects.toThrow()
  expect(calls).toBe(0)
  const pending = [loader.load(url, signal()), loader.load(url, signal())]
  const queued = new AbortController()
  const third = loader.load(url, queued.signal)
  await Bun.sleep(5); expect(calls).toBe(2)
  queued.abort(); await expect(third).rejects.toThrow()
  const fourth = loader.load(url, signal())
  loader.dispose()
  expect((await Promise.allSettled([...pending, fourth])).every(value => value.status === "rejected")).toBe(true)
  expect(calls).toBe(2)
  await expect(loader.load(url, signal())).rejects.toThrow()
})

test("queued requests proceed when slots free and LRU evicts old byte buffers", async () => {
  let calls = 0
  const loader = new ImagePreviews(async () => { calls++; await Bun.sleep(1); return new Response(png) })
  const urls = Array.from({ length: imageLimits.cacheEntries + 1 }, (_, index) => `${url}?${index}`)
  const images = await Promise.all(urls.map(target => loader.load(target, signal())))
  images.forEach(image => image.dispose())
  expect(calls).toBe(urls.length)
  const cached = await loader.load(urls[1]!, signal()); cached.dispose()
  expect(calls).toBe(urls.length)
  const evicted = await loader.load(urls[0]!, signal()); evicted.dispose()
  expect(calls).toBe(urls.length + 1)
  loader.dispose()
})

test("byte cache stays bounded even when fewer than 32 images are loaded", async () => {
  let calls = 0
  const large = testPng(1280, 1280, 1280, 1280, 0)
  expect(large.byteLength).toBeGreaterThan(imageLimits.cacheBytes / 3)
  const loader = new ImagePreviews(async () => { calls++; return new Response(large) })
  for (const key of ["a", "b", "c", "b"]) {
    const image = await loader.load(`${url}?${key}`, signal()); image.dispose()
  }
  expect(calls).toBe(3)
  const evicted = await loader.load(`${url}?a`, signal()); evicted.dispose()
  expect(calls).toBe(4)
  loader.dispose()
})
