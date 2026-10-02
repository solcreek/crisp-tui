import { expect, test } from "bun:test"
import { StyledText, TextAttributes } from "@opentui/core"
import { formatMessage } from "../src/ui/message-format"

function plain(value: string) {
  const result = formatMessage(value)
  return typeof result === "string" ? result : result.chunks.map(chunk => chunk.text).join("")
}

test("escaped punctuation is decoded once, including Unicode, without changing code", () => {
  expect(plain("步驟 😀 1\\. 開啟\n2\\. 設定")).toBe("步驟 😀 1. 開啟\n2. 設定")
  expect(plain("\\*literal\\* and \\[label\\] and \\\\ and \\_word\\_")).toBe("*literal* and [label] and \\ and _word_")
  expect(plain("`1\\.` and ``a`\\.``\n\n```js\nconst x = /\\./\n```"))
    .toBe("1\\. and a`\\.\n\nconst x = /\\./")
  expect(plain("    1\\. code\n    2\\. code\n")).toBe("1\\. code\n2\\. code\n")
  expect(plain("C:\\Users\\demo")).toBe("C:\\Users\\demo")
})

test("Crisp formatting keeps numbered lists, links, headings and emphasis readable", () => {
  expect(plain("1. First\n2. Second\n3. Third")).toBe("1. First\n2. Second\n3. Third")
  expect(plain("- First\n- Second")).toBe("• First\n• Second")
  expect(plain("# Heading\n\n> Quoted **text**\n\n~~Removed~~ and *emphasis*\n\n[line](https://example.com)"))
    .toContain("Heading\n\n│ Quoted text")
  expect(plain("[line](https://example.com)")).toBe("line (https://example.com)")
  expect(plain("![chart](https://example.com/chart.png)")).toBe("[chart] (https://example.com/chart.png)")
  expect(plain("![ ](https://example.com/chart.png)")).toContain("https://example.com/chart.png")
  expect(plain("[https://example.com](https://example.com)")).toBe("https://example.com")
  expect(plain("**one**  \n**two**")).toBe("one\ntwo")
  const result = formatMessage("***Important***") as StyledText
  expect(result.chunks[0]!.attributes! & TextAttributes.BOLD).not.toBe(0)
  expect(result.chunks[0]!.attributes! & TextAttributes.ITALIC).not.toBe(0)
})

test("plain messages use the fast path and unusual markup remains visible", () => {
  expect(formatMessage("Hello\nworld 😀")).toBe("Hello\nworld 😀")
  expect(plain("<tag>**bold**</tag>")).toContain("<tag>")
  expect(plain("| a | b |\n|---|---|\n| c | d |")).toContain("| a | b |")
})
