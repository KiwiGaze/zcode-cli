import { describe, expect, test } from "bun:test"
import { render } from "ink-testing-library"
import { Markdown } from "@/ui/components/Markdown"
import { resolveTheme, ThemeContext } from "@/ui/theme"

describe("Markdown", () => {
  test("renders supported block and inline content with visible link targets", () => {
    const source = [
      "# Heading",
      "",
      "A **strong** and *soft* [link](https://example.com).",
      "",
      "- first",
      "- second",
      "",
      "> quoted",
      "",
      "```ts",
      "const answer = 42",
      "```",
    ].join("\n")
    const { lastFrame } = render(<Markdown text={source} live={false} />)
    const frame = lastFrame() ?? ""

    expect(frame).toContain("Heading")
    expect(frame).toContain("strong")
    expect(frame).toContain("soft")
    expect(frame).toContain("link (https://example.com)")
    expect(frame).toContain("• first")
    expect(frame).toContain("• second")
    expect(frame).toContain("│ quoted")
    expect(frame).toContain("const answer = 42")
  })

  test("keeps an unclosed fence in code presentation while closing ticks stream in", () => {
    const theme = resolveTheme({ theme: "dark" }, { NO_COLOR: "1" })
    const completed = render(
      <ThemeContext value={theme}>
        <Markdown text={"```ts\nconst stable = true\n```"} live={false} />
      </ThemeContext>,
    ).lastFrame()

    for (const suffix of ["", "`", "``"]) {
      const { lastFrame } = render(
        <ThemeContext value={theme}>
          <Markdown text={`\`\`\`ts\nconst stable = true\n${suffix}`} live />
        </ThemeContext>,
      )
      expect(lastFrame()).toBe(completed)
    }
  })

  test("does not flash partial opening fences as prose", () => {
    for (const source of ["`", "``"]) {
      const { lastFrame } = render(<Markdown text={source} live />)
      expect(lastFrame()?.trim() ?? "").toBe("")
    }
  })

  test("strips hostile terminal sequences before lexing", () => {
    const source = "safe\u001b]52;c;stolen\u0007 text\u001b[2J"
    const { lastFrame } = render(<Markdown text={source} live={false} />)
    const frame = lastFrame() ?? ""

    expect(frame).toContain("safe text")
    expect(frame).not.toContain("stolen")
    expect(frame).not.toContain("\u001b")
  })

  test("renders code without syntax escape sequences when colors are disabled", () => {
    const theme = resolveTheme({ theme: "dark" }, { NO_COLOR: "1" })
    const { lastFrame } = render(
      <ThemeContext value={theme}>
        <Markdown text={"```ts\nconst answer = 42\n```"} live={false} />
      </ThemeContext>,
    )
    const frame = lastFrame() ?? ""

    expect(frame).toContain("const answer = 42")
    expect(frame).not.toContain("\u001b")
  })

  test("finalized literal backtick lines are not removed as streaming fence prefixes", () => {
    for (const ticks of ["`", "``"]) {
      const { lastFrame } = render(<Markdown text={`literal\n${ticks}`} live={false} />)
      expect(lastFrame()).toContain(ticks)
    }
  })
})
