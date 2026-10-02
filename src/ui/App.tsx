import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import type { Store } from "../store"
import { defaultLayout, type LayoutConfig } from "../layout"
import { conversationDetails } from "../details"
import { DetailsPanel } from "./DetailsPanel"
import { clean, label } from "../types"
import { MessageBody } from "./MessageBody"

const color = { bg: "#111823", panel: "#182333", fg: "#dbe7f7", dim: "#8799b2", blue: "#54a5ff", line: "#2b3d54", green: "#6ad6b1", note: "#f0c36a", error: "#ff929b" }
type Pane = "inbox" | "messages" | "composer" | "search" | "details"

export function App(props: { store: Store; bindFocus?: (fn: () => void) => void; layout?: LayoutConfig }) {
  const store = props.store
  const [state, setState] = createSignal(store.state)
  const unsubscribe = store.subscribe(() => setState(store.state))
  onCleanup(unsubscribe)
  const [pane, setPane] = createSignal<Pane>("inbox")
  const [cursor, setCursor] = createSignal(0)
  const [query, setQuery] = createSignal("")
  const dims = useTerminalDimensions()
  const sidebar = () => (props.layout ?? defaultLayout).sidebar
  const [detailsEnabled, setDetailsEnabled] = createSignal(sidebar().enabled)
  const showDetails = () => detailsEnabled() && dims().width >= 84 + sidebar().width
  const active = createMemo(() => state().active)
  const selected = createMemo(() => active() ?? state().conversations.find(c => c.session_id === state().selectedSession))
  const groups = createMemo(() => store.metrics.sync("details.project", () => conversationDetails(active(), sidebar())))
  let details: ScrollBoxRenderable | undefined
  createEffect(() => { if (!showDetails() && pane() === "details") setPane("messages") })
  let textarea: TextareaRenderable | undefined
  let history: ScrollBoxRenderable | undefined
  let inbox: ScrollBoxRenderable | undefined
  const draft = () => { state(); return store.draft() }
  const run = (fn: () => Promise<unknown>) => void store.perform(fn)
  props.bindFocus?.(() => setPane(state().readOnly ? "messages" : "composer"))

  createEffect(() => {
    const text = draft().text
    if (textarea && textarea.plainText !== text) { textarea.setText(text); textarea.gotoBufferEnd() }
  })
  createEffect(() => {
    const length = state().conversations.length
    if (cursor() >= length) setCursor(Math.max(0, length - 1))
  })
  createEffect(() => {
    const index = cursor()
    inbox?.scrollTo(Math.max(0, index * 3 - 3))
  })
  const open = (id: string) => {
    setPane(state().readOnly ? "messages" : "composer")
    run(() => store.open(id))
  }
  useKeyboard(key => {
    if (key.ctrl) {
      if (key.name === "b") { key.preventDefault(); setDetailsEnabled(value => !value); return }
      if (key.name === "r") { key.preventDefault(); run(() => store.refresh()); return }
      if (key.name === "n") { key.preventDefault(); if (state().active && !state().sending && !state().readOnly) store.setDraft(draft().text, !draft().note); return }
      if (key.name === "e") { key.preventDefault(); run(() => store.changeState()); return }
      if (key.name === "u") { key.preventDefault(); run(() => store.markRead()); return }
    }
    if (key.name === "escape") { setPane("inbox"); return }
    if (key.name === "tab") {
      key.preventDefault()
      const order: Pane[] = state().readOnly ? ["inbox", "messages"] : ["inbox", "messages", "composer"]
      if (showDetails()) order.push("details")
      setPane(order[(order.indexOf(pane()) + (key.shift ? order.length - 1 : 1)) % order.length]!)
      return
    }
    if (pane() === "composer" || pane() === "search") return
    if (key.name === "/") { key.preventDefault(); setQuery(state().query); setPane("search"); return }
    if (key.name === "[") { run(() => store.list(state().query, Math.max(1, state().page - 1))); return }
    if (key.name === "]") { run(() => store.list(state().query, state().page + 1)); return }
    if (pane() === "inbox") {
      if (key.name === "down" || key.name === "j") setCursor(i => Math.min(Math.max(0, state().conversations.length - 1), i + 1))
      if (key.name === "up" || key.name === "k") setCursor(i => Math.max(0, i - 1))
      if (key.name === "return") {
        const c = state().conversations[cursor()]
        if (c) open(c.session_id)
      }
    }
    if (pane() === "details") {
      if (["down", "j", "pagedown"].includes(key.name)) details?.scrollBy(key.name === "pagedown" ? 10 : 1)
      if (["up", "k", "pageup"].includes(key.name)) details?.scrollBy(key.name === "pageup" ? -10 : -1)
    }
    if (pane() === "messages") {
      if (["down", "j", "pagedown"].includes(key.name)) history?.scrollBy(key.name === "pagedown" ? 10 : 1)
      if (["up", "k", "pageup"].includes(key.name)) history?.scrollBy(key.name === "pageup" ? -10 : -1)
    }
  })

  return <box flexDirection="column" width="100%" height="100%" backgroundColor={color.bg}>
    <box height={3} flexShrink={0} flexDirection="row" alignItems="center" paddingLeft={2} paddingRight={2} backgroundColor={color.panel}>
      <text fg={color.blue}><b>crisp</b></text>
      <text fg={color.fg}>  /  support inbox</text>
      <Show when={state().readOnly}><text fg={color.note}>  READ ONLY</text></Show>
      <Show when={state().realtime !== "off"}><text fg={state().realtime === "authenticated" ? color.green : color.note}>{`  RTM ${state().realtime === "authenticated" ? "live" : state().realtime}`}</text></Show>
      <box flexGrow={1} />
      <text fg={state().source.startsWith("DEMO") ? color.note : color.green} truncate wrapMode="none">{clean(state().source)}</text>
    </box>
    <box flexGrow={1} minHeight={0} flexDirection="row">
      <box width={dims().width < 90 ? 25 : 34} flexShrink={0} flexDirection="column" border={["right"]} borderColor={pane() === "inbox" ? color.blue : color.line} backgroundColor={color.panel}>
        <text paddingLeft={1} height={2} fg={color.dim}>{`INBOX · page ${state().page}${state().loading ? " · loading" : ""}`}</text>
        <Show when={pane() === "search"} fallback={<text paddingLeft={1} height={2} fg={color.dim}>{state().query ? `Search: ${clean(state().query)}` : "/ Search conversations"}</text>}>
          <input value={query()} focused={pane() === "search"} onInput={setQuery} onSubmit={() => { setPane("inbox"); setCursor(0); run(() => store.list(query(), 1)) }} placeholder="Search · Enter to submit" />
        </Show>
        <scrollbox ref={inbox} flexGrow={1} minHeight={0}>
          <For each={state().conversations}>{(c, i) => <box height={3} flexShrink={0} paddingLeft={1} paddingRight={1}
            flexDirection="column" backgroundColor={state().selectedSession === c.session_id ? "#234465" : pane() === "inbox" && cursor() === i() ? "#263448" : undefined}
            onMouseUp={() => { setCursor(i()); open(c.session_id) }}>
            <text fg={color.fg} truncate wrapMode="none">{c.state === "resolved" ? "✓ " : "● "}{clean(label(c))}{c.unread?.operator ? ` (${c.unread.operator})` : ""}</text>
            <text fg={color.dim} truncate wrapMode="none">{clean(c.last_message || c.meta?.email || c.session_id)}</text>
          </box>}</For>
          <Show when={!state().loading && !state().conversations.length}><text padding={1} fg={color.dim}>No conversations on this page.</text></Show>
        </scrollbox>
        <text paddingLeft={1} height={2} fg={color.dim}>[ previous   ] next</text>
      </box>
      <box flexGrow={1} minWidth={0} flexDirection="column">
        <box height={4} flexShrink={0} paddingLeft={2} paddingRight={1} paddingTop={1} flexDirection="column" border={["bottom"]} borderColor={color.line}>
          <text fg={color.fg} truncate wrapMode="none"><b>{selected() ? clean(label(selected()!)) : "Choose a conversation"}</b>{selected() ? `  ·  ${selected()!.state || "unknown"}` : ""}{state().conversationCached ? "  ·  saved copy" : ""}{state().conversationLoading ? "  ·  updating…" : ""}</text>
          <text fg={color.dim} truncate wrapMode="none">{clean([selected()?.meta?.email, ...(selected()?.meta?.segments || [])].filter(Boolean).join(" · "))}</text>
        </box>
        <scrollbox ref={history} flexGrow={1} minHeight={0} stickyScroll stickyStart="bottom" border={pane() === "messages" ? ["left"] : undefined} borderColor={color.blue} paddingLeft={2} paddingRight={2}>
          <Show when={state().messagesLoading && !state().messagesReady}><text fg={color.dim} marginTop={1}>Loading messages…</text></Show>
          <For each={state().messages}>{m => <box flexDirection="column" flexShrink={0} marginTop={1} marginBottom={1}>
            <text fg={m.type === "note" ? color.note : m.from === "operator" ? color.blue : color.green}>
              <b>{clean(m.user?.nickname || (m.from === "operator" ? "Operator" : "Visitor"))}</b>
              {m.type === "note" ? " · INTERNAL NOTE" : ""}
              <span style={{ fg: color.dim }}>{m.timestamp ? `  ${new Date(m.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}</span>
            </text>
            <MessageBody message={m} />
          </box>}</For>
          <Show when={state().messagesReady && !state().messages.length}><text fg={color.dim} marginTop={1}>No messages.</text></Show>
        </scrollbox>
        <Show when={!state().readOnly} fallback={<text height={2} paddingLeft={2} fg={color.note}>Read only · sending and conversation changes disabled</text>}>
        <box flexShrink={0} minHeight={5} maxHeight={10} marginLeft={1} marginRight={1} border borderStyle="rounded"
          borderColor={draft().note ? color.note : pane() === "composer" ? color.blue : color.line}
          title={draft().note ? " Internal note · Ctrl+N for reply " : " Reply · Ctrl+N for internal note "}
          onMouseUp={() => setPane("composer")}>
          <textarea ref={el => { textarea = el }} minHeight={3} maxHeight={8} flexGrow={1}
            focused={pane() === "composer" && !!state().active && !state().sending}
            textColor={color.fg} placeholderColor={color.dim}
            placeholder={state().sending ? "Sending…" : "Enter to send · Shift+Enter for newline"}
            keyBindings={[
              { name: "return", action: "submit" }, { name: "return", shift: true, action: "newline" },
              { name: "return", meta: true, action: "newline" }, { name: "j", ctrl: true, action: "newline" },
              { name: "linefeed", action: "newline" },
            ]}
            onContentChange={() => {
              if (textarea && state().active && !state().sending && textarea.plainText !== draft().text) store.setDraft(textarea.plainText)
            }}
            onSubmit={() => run(() => store.send())} />
        </box>
        </Show>
      </box>
      <Show when={showDetails()}>
        <DetailsPanel width={sidebar().width} focused={pane() === "details"} groups={groups()}
          loading={state().detailsLoading} selected={!!state().active}
          unavailable={!!state().selectedSession && !state().active}
          bindScroll={value => { details = value }} focus={() => setPane("details")} />
      </Show>
    </box>
    <text height={1} flexShrink={0} paddingLeft={1} fg={state().error ? color.error : color.dim} truncate wrapMode="none">{state().error || state().status}</text>
    <text height={1} flexShrink={0} paddingLeft={1} fg={color.dim} bg={color.panel} truncate wrapMode="none">{state().readOnly ? "Tab panes · / search · ^R refresh · ^B details · ^C quit · READ ONLY" : "Tab panes · / search · ^R refresh · ^E resolve/reopen · ^U read · ^B details · ^C quit"}</text>
  </box>
}
