import { For, Show } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import type { DetailGroup } from "../details"

export function DetailsPanel(props: { width: number; focused: boolean; groups: DetailGroup[]; loading: boolean; selected: boolean; bindScroll: (value: ScrollBoxRenderable) => void; focus: () => void }) {
  return <box width={props.width} flexShrink={0} flexDirection="column" border={["left"]}
    borderColor={props.focused ? "#54a5ff" : "#2b3d54"} backgroundColor="#182333" onMouseUp={props.focus}>
    <text height={2} paddingLeft={1} fg="#54a5ff">DETAILS · Ctrl+B toggle</text>
    <scrollbox ref={props.bindScroll} flexGrow={1} minHeight={0} paddingLeft={1} paddingRight={1}>
      <Show when={props.selected} fallback={<text fg="#8799b2">{props.loading ? "Loading details…" : "Choose a conversation"}</text>}>
        <For each={props.groups}>{group => <box flexDirection="column" flexShrink={0} marginBottom={1}>
          <text fg="#dbe7f7"><b>{group.title}</b></text>
          <Show when={group.rows.length} fallback={<text fg="#8799b2">No data available</text>}>
            <For each={group.rows}>{field => <box flexDirection="column" flexShrink={0} marginTop={1}>
              <text fg="#8799b2" wrapMode="word">{field.label}</text>
              <text fg="#dbe7f7" wrapMode="word">{field.value}</text>
            </box>}</For>
          </Show>
          <Show when={group.truncated}><text fg="#8799b2">Additional fields not shown.</text></Show>
        </box>}</For>
      </Show>
    </scrollbox>
  </box>
}
