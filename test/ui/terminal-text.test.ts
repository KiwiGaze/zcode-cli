import { expect, test } from "bun:test"
import { sanitizeTerminalLine, sanitizeTerminalText, sanitizeTerminalTitle } from "@/ui/terminal-text"

const ESCAPE = "\u001b"

test("terminal text preserves printable Unicode, tabs, and newlines", () => {
  expect(sanitizeTerminalText("plain 👨‍👩‍👧‍👦\t中文\nnext")).toBe("plain 👨‍👩‍👧‍👦\t中文\nnext")
})

test("terminal text strips CSI and C0 or C1 controls", () => {
  const hostile = ["before", `${ESCAPE}[31mred${ESCAPE}[0m`, "\u009b?1004hfocus", "\u0000\u0007\u0008", "after"].join(
    "",
  )
  expect(sanitizeTerminalText(hostile)).toBe("beforeredfocusafter")
})

test("terminal text strips OSC clipboard and title sequences with either terminator", () => {
  const hostile = `safe${ESCAPE}]52;c;Y2xpcGJvYXJk\u0007middle` + `${ESCAPE}]0;forged title${ESCAPE}\\after`
  expect(sanitizeTerminalText(hostile)).toBe("safemiddleafter")
})

test("terminal text strips DCS, APC, and PM control strings", () => {
  const hostile = `a${ESCAPE}Ppayload${ESCAPE}\\b` + `${ESCAPE}_payload\u009cc` + `${ESCAPE}^payload${ESCAPE}\\d`
  expect(sanitizeTerminalText(hostile)).toBe("abcd")
})

test("terminal lines collapse multiline hostile content into one printable preview", () => {
  expect(sanitizeTerminalLine(`  first\n${ESCAPE}]52;c;stolen\u0007\tsecond  `)).toBe("first second")
})

test("only OSC treats BEL as a control-string terminator", () => {
  expect(sanitizeTerminalText(`safe${ESCAPE}Ppayload\u0007still payload${ESCAPE}\\after`)).toBe("safeafter")
})

test("unterminated control sequences are discarded from their introducer", () => {
  expect(sanitizeTerminalText(`safe${ESCAPE}]52;c;unterminated`)).toBe("safe")
  expect(sanitizeTerminalText(`safe${ESCAPE}[31`)).toBe("safe")
  expect(sanitizeTerminalText(`safe\u009fpayload`)).toBe("safe")
})

test("terminal titles are single-line, sanitized, and bounded by Unicode code point", () => {
  const hostile = `job\n${ESCAPE}]0;forged\u0007\t😀😀😀`
  expect(sanitizeTerminalTitle(hostile, 6)).toBe("job😀😀😀")
  expect(sanitizeTerminalTitle("😀😀", 1)).toBe("😀")
})

test("terminal title rejects invalid bounds", () => {
  expect(() => sanitizeTerminalTitle("title", -1)).toThrow(RangeError)
  expect(() => sanitizeTerminalTitle("title", 1.5)).toThrow(RangeError)
})
