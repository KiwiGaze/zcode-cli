import { expect, test } from "bun:test"
import { memoryDir, sessionDir } from "@/config/paths"

test("project data directories do not collide for paths with the same punctuation slug", () => {
  const hyphenated = "/work/a-b"
  const nested = "/work/a/b"

  expect(sessionDir(hyphenated)).not.toBe(sessionDir(nested))
  expect(memoryDir(hyphenated)).not.toBe(memoryDir(nested))
})

test("project data directories normalize lexical path aliases", () => {
  expect(sessionDir("/work/a/../a/b")).toBe(sessionDir("/work/a/b"))
})
