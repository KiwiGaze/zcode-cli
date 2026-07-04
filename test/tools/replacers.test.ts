import { test, expect } from "bun:test"
import { replace } from "@/tools/edit/replacers"

test("simple exact replacement", () => {
  expect(replace("const a = 1", "a = 1", "a = 2")).toBe("const a = 2")
})

test("line-trimmed replacer tolerates differing surrounding whitespace", () => {
  const content = "function f() {\n    return 1\n}\n"
  const result = replace(content, "function f() {\nreturn 1\n}", "function f() {\n    return 2\n}")
  expect(result).toContain("return 2")
})

test("indentation-flexible replacer matches shifted indentation", () => {
  const content = "class C {\n        method() {\n            return 1\n        }\n}\n"
  const result = replace(content, "method() {\n    return 1\n}", "method() {\n    return 2\n}")
  expect(result).toContain("return 2")
})

test("replaceAll replaces every occurrence", () => {
  expect(replace("x x x", "x", "y", true)).toBe("y y y")
})

test("throws when oldString is not found", () => {
  expect(() => replace("hello", "world", "there")).toThrow(/Could not find oldString/)
})

test("throws when oldString and newString are identical", () => {
  expect(() => replace("hello", "hello", "hello")).toThrow(/identical/)
})

test("throws on ambiguous multiple matches without replaceAll", () => {
  expect(() => replace("a\na\n", "a", "b")).toThrow(/multiple matches/)
})

test("block-anchor replacer matches on first and last line with fuzzy middle", () => {
  const content = ["function outer() {", "  const value = compute()", "  return value", "}"].join("\n")
  const find = ["function outer() {", "  const value = different()", "  return value", "}"].join("\n")
  const replacement = ["function outer() {", "  return 42", "}"].join("\n")
  const result = replace(content, find, replacement)
  expect(result).toContain("return 42")
})
