import { test, expect } from "bun:test"
import {
  createPasteAssembler,
  feedPasteChunk,
  normalizePaste,
  shouldCollapsePaste,
  formatPastePill,
  expandPastePills,
  pillEndingAt,
  pastePillStartingAt,
} from "@/ui/paste"

const ESC = String.fromCharCode(27)

test("feedPasteChunk assembles a paste delivered in one chunk (Ink strips leading ESC)", () => {
  const state = createPasteAssembler()
  const result = feedPasteChunk(state, "[200~hello\rworld" + ESC + "[201~")
  expect(result.consumed).toBe(true)
  expect(result.parts).toEqual([{ kind: "paste", value: "hello\rworld" }])
  expect(state.active).toBe(false)
})

test("feedPasteChunk assembles a paste split across multiple chunks", () => {
  const state = createPasteAssembler()
  const first = feedPasteChunk(state, "[200~line one\nline two\n")
  expect(first.consumed).toBe(true)
  expect(first.parts).toEqual([])
  expect(state.active).toBe(true)

  const second = feedPasteChunk(state, "line three")
  expect(second.consumed).toBe(true)
  expect(second.parts).toEqual([])

  const third = feedPasteChunk(state, ESC + "[201~")
  expect(third.consumed).toBe(true)
  expect(third.parts).toEqual([{ kind: "paste", value: "line one\nline two\nline three" }])
  expect(state.active).toBe(false)
})

test("feedPasteChunk recognizes start and end markers split at arbitrary boundaries", () => {
  const state = createPasteAssembler()

  expect(feedPasteChunk(state, `${ESC}[20`)).toEqual({ consumed: true, parts: [] })
  expect(feedPasteChunk(state, "0~line one\nline two")).toEqual({ consumed: true, parts: [] })
  expect(state.active).toBe(true)
  expect(feedPasteChunk(state, `${ESC}[20`)).toEqual({ consumed: true, parts: [] })
  expect(feedPasteChunk(state, "1~after")).toEqual({
    consumed: true,
    parts: [
      { kind: "paste", value: "line one\nline two" },
      { kind: "text", value: "after" },
    ],
  })
  expect(state.active).toBe(false)
})

test("feedPasteChunk ignores ordinary keystrokes", () => {
  const state = createPasteAssembler()
  expect(feedPasteChunk(state, "a")).toEqual({ consumed: false, parts: [] })
  expect(feedPasteChunk(state, "\r")).toEqual({ consumed: false, parts: [] })
  expect(state.active).toBe(false)
})

test("feedPasteChunk preserves ordinary text around one or more framed pastes", () => {
  const state = createPasteAssembler()
  expect(feedPasteChunk(state, `before${ESC}[200~one${ESC}[201~middle${ESC}[200~two${ESC}[201~after`)).toEqual({
    consumed: true,
    parts: [
      { kind: "text", value: "before" },
      { kind: "paste", value: "one" },
      { kind: "text", value: "middle" },
      { kind: "paste", value: "two" },
      { kind: "text", value: "after" },
    ],
  })
})

test("normalizePaste turns CRLF and CR into LF", () => {
  expect(normalizePaste("a\r\nb\rc\nd")).toBe("a\nb\nc\nd")
})

test("shouldCollapsePaste triggers on 3+ lines or long text", () => {
  expect(shouldCollapsePaste("one\ntwo")).toBe(false)
  expect(shouldCollapsePaste("one\ntwo\nthree")).toBe(true)
  expect(shouldCollapsePaste("x".repeat(401))).toBe(true)
  expect(shouldCollapsePaste("short")).toBe(false)
})

test("formatPastePill and expandPastePills round-trip through a store", () => {
  const content = "a\nb\nc\nd\ne"
  const pill = formatPastePill(7, content)
  expect(pill).toBe("[Pasted #7, 5 lines]")

  const store = new Map<number, string>([[7, content]])
  const value = "explain " + pill + " please"
  expect(expandPastePills(value, store)).toBe("explain " + content + " please")
})

test("expandPastePills leaves unknown or edited pills untouched", () => {
  const store = new Map<number, string>()
  expect(expandPastePills("[Pasted #9, 3 lines]", store)).toBe("[Pasted #9, 3 lines]")
  expect(expandPastePills("[Pasted #1, 5 lin", store)).toBe("[Pasted #1, 5 lin")
})

test("pillEndingAt matches only a whole pill ending exactly at the cursor", () => {
  const value = "see [Pasted #3, 5 lines]"
  expect(pillEndingAt(value, value.length)).toEqual({ start: 4, end: value.length, id: 3 })
  expect(pillEndingAt(value, value.length - 1)).toBeNull()
  expect(pillEndingAt("no pill", 4)).toBeNull()
})

test("pastePillStartingAt matches only a whole pill starting exactly at the cursor", () => {
  const value = "see [Pasted #3, 5 lines] next"
  expect(pastePillStartingAt(value, 4)).toEqual({ start: 4, end: 24, id: 3 })
  expect(pastePillStartingAt(value, 5)).toBeNull()
  expect(pastePillStartingAt("no pill", 0)).toBeNull()
})
