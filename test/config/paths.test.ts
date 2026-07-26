import { expect, test } from "bun:test"
import { memoryDir, sessionDir } from "@/config/paths"

test("memory directories do not collide for paths with the same punctuation slug", () => {
  const hyphenated = "/work/a-b"
  const nested = "/work/a/b"

  expect(memoryDir(hyphenated)).not.toBe(memoryDir(nested))
})

test("memory directories normalize lexical path aliases without changing session lookup", () => {
  expect(memoryDir("/work/a/../a/b")).toBe(memoryDir("/work/a/b"))
  expect(sessionDir("/work/a-b")).toBe(sessionDir("/work/a/b"))
})
