import { test, expect } from "bun:test"
import { clipMiddle, toSingleLine, truncateToBytes } from "@/util/text"

test("clipMiddle keeps both ends and never exceeds the budget", () => {
  const text = `HEAD${"x".repeat(500)}TAIL`
  const clipped = clipMiddle(text, 100)

  expect(clipped.length).toBeLessThanOrEqual(100)
  expect(clipped.startsWith("HEAD")).toBe(true)
  expect(clipped.endsWith("TAIL")).toBe(true)
  expect(clipped).toMatch(/…\[\d+ chars\]…/)
})

test("clipMiddle leaves text already inside the budget untouched", () => {
  expect(clipMiddle("short", 100)).toBe("short")
  expect(clipMiddle("exactly-ten", 11)).toBe("exactly-ten")
})

test("clipMiddle withholds the payload when the budget cannot hold the marker", () => {
  // The failure that matters: a budget smaller than the marker must not spill head and tail anyway,
  // which is how a secret escapes the very cap meant to contain it.
  const secret = "AKIA0123456789ABCDEF"
  for (const budget of [8, 0, -1]) {
    const clipped = clipMiddle(secret, budget)
    expect(clipped.length).toBeLessThanOrEqual(Math.max(0, budget))
    expect(clipped).not.toContain("AKIA")
    expect(clipped).not.toContain("ABCDEF")
  }
})

test("truncateToBytes cuts on a byte budget, not code units", () => {
  const cjk = "字".repeat(10)
  const cut = truncateToBytes(cjk, 10)

  expect(Buffer.byteLength(cut, "utf8")).toBeLessThanOrEqual(10)
  expect(cut).toBe("字字字")
  expect(cut).not.toContain("�")
})

test("toSingleLine collapses the line breaks that would forge a second record", () => {
  expect(toSingleLine("first\nsecond")).toBe("first second")
  expect(toSingleLine("  a\r\n\r\nb  ")).toBe("a b")
})
