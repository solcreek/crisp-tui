import { createEffect, createMemo, Show } from "solid-js"
import type { TextRenderable } from "@opentui/core"
import { messageText, type Message } from "../types"
import { formatMessage } from "./message-format"
import { imageAttachment, type ImagePreviews } from "../images"
import { ImageAttachment } from "./ImageAttachment"

export function MessageBody(props: { message: Message; previews?: ImagePreviews; rows?: number }) {
  const content = createMemo(() => typeof props.message.content === "string"
    ? formatMessage(messageText(props.message)) : messageText(props.message))
  const url = createMemo(() => imageAttachment(props.message))
  let text: TextRenderable | undefined
  // Solid's `content` prop coerces StyledText to a string; use the native setter.
  createEffect(() => { const value = content(); if (text) text.content = value })
  return <>
    <text ref={text} fg="#dbe7f7" wrapMode="word" />
    <Show when={props.previews && url()}>
      <ImageAttachment url={url()!} previews={props.previews!} rows={props.rows ?? 24} />
    </Show>
  </>
}
