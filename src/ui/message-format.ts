import { RGBA, StyledText, TextAttributes, type TextChunk } from "@opentui/core"
import { Lexer, type Token, type Tokens } from "marked"

const blue = RGBA.fromHex("#54a5ff"), code = RGBA.fromHex("#f0c36a")

// Parse once per changed message, synchronously. A text buffer avoids a syntax
// worker and a renderable tree per Markdown block in long conversations.
export function formatMessage(content: string): string | StyledText {
  if (!/[\\`*_~#[\]|]|(^|\n)\s*(?:[-+>]|\d+[.)])(?:\s|$)/.test(content)) return content
  const chunks: TextChunk[] = []
  type Style = Pick<TextChunk, "attributes" | "fg">
  const append = (text: string, style: Style) => { if (text) chunks.push({ __isChunk: true, text, ...style }) }
  const render = (tokens: Token[] = [], style: Style = {}) => {
    for (const token of tokens) {
      const trailing = token.raw.match(/\n+$/)?.[0] ?? ""
      switch (token.type) {
        case "strong": case "em": case "del":
          render(token.tokens, { ...style, attributes: (style.attributes ?? 0) |
            (token.type === "strong" ? TextAttributes.BOLD : token.type === "em" ? TextAttributes.ITALIC : TextAttributes.STRIKETHROUGH) })
          break
        case "code": case "codespan":
          append(token.text, { ...style, fg: code }); if (token.type === "code") append(trailing, style)
          break
        case "escape": append(token.text, style); break
        case "heading":
          render(token.tokens, { ...style, fg: blue, attributes: (style.attributes ?? 0) | TextAttributes.BOLD }); append(trailing, style)
          break
        case "paragraph": case "text":
          if (token.tokens) { render(token.tokens, style); if (token.type === "paragraph") append(trailing, style) }
          else append(token.text, style)
          break
        case "link": case "image":
          if (token.type === "link") render(token.tokens, { ...style, fg: blue })
          else append(`[${token.text || "image"}]`, style)
          // Keep destinations visible even without OSC 8 / mouse support.
          if (token.href !== token.text) append(` (${token.href})`, { ...style, fg: blue })
          break
        case "list":
          token.items.forEach((item: Tokens.ListItem, index: number) => {
            append(token.ordered ? `${Number(token.start) + index}. ` : "• ", style)
            render(item.tokens, style)
            if (index < token.items.length - 1 && !chunks.at(-1)?.text.endsWith("\n")) append("\n", style)
          })
          append(trailing, style)
          break
        case "blockquote": append("│ ", style); render(token.tokens, style); break
        case "br": append("\n", style); break
        default: append(token.raw, style)
      }
    }
  }
  render(Lexer.lex(content))
  return new StyledText(chunks)
}
