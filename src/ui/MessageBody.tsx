import { createEffect, createMemo } from "solid-js"
import type { TextRenderable } from "@opentui/core"
import { messageText, type Message } from "../types"
import { formatMessage } from "./message-format"

export function MessageBody(props: { message: Message }) {
  const content = createMemo(() => typeof props.message.content === "string"
    ? formatMessage(messageText(props.message)) : messageText(props.message))
  let text: TextRenderable | undefined
  // Solid's `content` prop coerces StyledText to a string; use the native setter.
  createEffect(() => { const value = content(); if (text) text.content = value })
  return <text ref={text} fg="#dbe7f7" wrapMode="word" />
}
