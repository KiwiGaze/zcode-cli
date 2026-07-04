import { test, expect } from "bun:test"
import {
  createPasteAssembler,
  feedPasteChunk,
  normalizePaste,
  shouldCollapsePaste,
  formatPastePill,
  expandPastePills,
} from "@/ui/paste"

const ESC = String.fromCharCode(27)

test("feedPasteChunk assembles a paste delivered in one chunk (Ink strips leading ESC)", () => {
  const state = createPasteAssembler()
  const result = feedPasteChunk(state, "[200~hello\rworld" + ESC + "[201~")
  expect(result.consumed).toBe(true)
  expect(result.complete).toBe("hello\rworld")
  expect(state.active).toBe(false)
})

test("feedPasteChunk assembles a paste split across multiple chunks", () => {
  const state = createPasteAssembler()
  const first = feedPasteChunk(state, "[200~line one\nline two\n")
  expect(first.consumed).toBe(true)
  expect(first.complete).toBeUndefined()
  expect(state.active).toBe(true)

  const second = feedPasteChunk(state, "line three")
  expect(second.consumed).toBe(true)
  expect(second.complete).toBeUndefined()

  const third = feedPasteChunk(state, ESC + "[201~")
  expect(third.consumed).toBe(true)
  expect(third.complete).toBe("line one\nline two\nline three")
  expect(state.active).toBe(false)
})

test("feedPasteChunk ignores ordinary keystrokes", () => {
  const state = createPasteAssembler()
  expect(feedPasteChunk(state, "a").consumed).toBe(false)
  expect(feedPasteChunk(state, "\r").consumed).toBe(false)
  expect(state.active).toBe(false)
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
