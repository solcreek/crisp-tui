import { ScrollBoxRenderable, type BoxRenderable, type NativeImage } from "@opentui/core"
import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import type { ImagePreviews } from "../images"

export function imageSize(width: number, height: number, columns: number, rows: number) {
  const maxColumns = Math.max(1, columns), maxRows = Math.max(1, Math.floor(rows * 0.45))
  const scale = Math.min(maxColumns / width, maxRows * 2 / height, 1 / 8)
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale / 2)) }
}

export function ImageAttachment(props: { url: string; previews: ImagePreviews; rows: number }) {
  const [visible, setVisible] = createSignal(false)
  const [columns, setColumns] = createSignal(1)
  const [image, setImage] = createSignal<NativeImage>()
  const [failed, setFailed] = createSignal(false)
  let box: BoxRenderable | undefined
  let alive = true, scheduled = false
  onCleanup(() => { alive = false })
  createEffect(() => {
    if (!visible()) return
    const controller = new AbortController()
    let loaded: NativeImage | undefined
    setImage(undefined); setFailed(false)
    void props.previews.load(props.url, controller.signal).then(value => {
      if (controller.signal.aborted) { value.dispose(); return }
      loaded = value
      setImage(value)
    }).catch(() => { if (!controller.signal.aborted) setFailed(true) })
    onCleanup(() => { controller.abort(); loaded?.dispose() })
  })
  const size = () => imageSize(image()?.width ?? 1, image()?.height ?? 1, columns(), props.rows)
  return <box ref={box} width="100%" flexDirection="column" flexShrink={0}
    onSizeChange={() => setColumns(box?.width ?? 1)}
    renderBefore={() => {
      // renderBefore also runs on clipped children. Check the viewport before
      // fetching; defer state changes until the frame is complete.
      if (!scheduled) {
        for (let parent = box?.parent; parent; parent = parent.parent) {
          if (parent instanceof ScrollBoxRenderable && box) {
            const viewport = parent.viewport
            if (box.screenY + box.height <= viewport.screenY || box.screenY >= viewport.screenY + viewport.height) return
          }
        }
        scheduled = true
        queueMicrotask(() => { if (alive) { setColumns(box?.width ?? 1); setVisible(true) } })
      }
    }}>
    <Show when={image() && !failed()} fallback={<text fg="#8799b2">{failed() ? "Preview unavailable · use the attachment link" : "Loading image…"}</text>}>
      <image source={image()} width={size().width} height={size().height} fit="fit" onError={() => setFailed(true)} />
    </Show>
  </box>
}
