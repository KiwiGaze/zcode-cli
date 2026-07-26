import { expect, test } from "bun:test"
import { resolveTerminalColorCapabilities, resolveTheme } from "@/ui/theme"

test("truecolor positive signals select RGB colors through screen and tmux", () => {
  for (const terminal of ["screen-256color", "tmux-256color"]) {
    const theme = resolveTheme({ theme: "dark" }, { TERM: terminal, COLORTERM: "truecolor" })
    expect(theme.colorsEnabled).toBe(true)
    expect(theme.text.accent).toBe("#6c9ee0")
  }

  expect(resolveTerminalColorCapabilities({ COLORTERM: "24BIT" }).truecolor).toBe(true)
})

test("terminals without a truecolor signal use the ANSI fallback", () => {
  const theme = resolveTheme({ theme: "dark" }, { TERM: "xterm-256color" })
  expect(theme.colorsEnabled).toBe(true)
  expect(theme.text.accent).toBe("blue")
  expect(theme.status.error).toBe("red")
})

test("auto appearance follows COLORFGBG and defaults unknown values to dark", () => {
  const truecolor = { COLORTERM: "truecolor" }
  expect(resolveTheme({ theme: "auto" }, { ...truecolor, COLORFGBG: "0;15" }).text.primary).toBe("#24292f")
  expect(resolveTheme({ theme: "auto" }, { ...truecolor, COLORFGBG: "15;0" }).text.primary).toBe("#e6edf3")
  expect(resolveTheme({ theme: "auto" }, { ...truecolor, COLORFGBG: "unknown" }).text.primary).toBe("#e6edf3")
  expect(resolveTheme({ theme: "auto" }, truecolor).text.primary).toBe("#e6edf3")
  expect(resolveTheme({ theme: "auto" }, { COLORFGBG: "0;15" }).text.primary).toBe("black")
  expect(resolveTheme({ theme: "auto" }, { COLORFGBG: "15;0" }).text.primary).toBe("white")
})

test("an explicit appearance ignores COLORFGBG", () => {
  const environment = { COLORTERM: "truecolor", COLORFGBG: "0;15" }
  expect(resolveTheme({ theme: "dark" }, environment).text.primary).toBe("#e6edf3")
  expect(resolveTheme({ theme: "light" }, { ...environment, COLORFGBG: "15;0" }).text.primary).toBe("#24292f")
})

test("non-empty NO_COLOR disables every semantic color", () => {
  const theme = resolveTheme({ theme: "dark" }, { NO_COLOR: "1", COLORTERM: "truecolor" })
  expect(theme.colorsEnabled).toBe(false)
  expect(theme).toEqual({
    colorsEnabled: false,
    text: { primary: undefined, muted: undefined, accent: undefined },
    status: { ok: undefined, warn: undefined, error: undefined, pending: undefined },
    diff: {
      added: undefined,
      removed: undefined,
      addedWord: undefined,
      removedWord: undefined,
      context: undefined,
    },
    syntax: {
      keyword: undefined,
      string: undefined,
      comment: undefined,
      number: undefined,
      function: undefined,
      type: undefined,
    },
  })
})

test("an empty NO_COLOR value does not disable colors", () => {
  expect(resolveTerminalColorCapabilities({ NO_COLOR: "" }).colorsEnabled).toBe(true)
})
