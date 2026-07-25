import { test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { readTool } from "@/tools/read"
import { writeTool } from "@/tools/write"
import { editTool } from "@/tools/edit"
import { FileState } from "@/tools/file-state"
import type { ToolContext } from "@/tools/registry"
import { createSession } from "@/session/session"

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "zcode-tools-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function context(files: FileState): ToolContext {
  return {
    cwd: dir,
    signal: new AbortController().signal,
    callId: "c1",
    sessionId: "s1",
    usageSession: createSession(dir),
    files,
    onProgress: () => {},
  }
}

test("read returns line-numbered content", async () => {
  await writeFile(path.join(dir, "a.txt"), "one\ntwo\nthree\n")
  const files = new FileState()
  const result = await readTool.execute({ filePath: "a.txt" }, context(files))
  expect(result.status).toBe("ok")
  expect(result.output).toContain("1: one")
  expect(result.output).toContain("3: three")
})

test("write refuses to overwrite a file that was not read", async () => {
  await writeFile(path.join(dir, "b.txt"), "old")
  const files = new FileState()
  const result = await writeTool.execute({ filePath: "b.txt", content: "new" }, context(files))
  expect(result.status).toBe("error")
  expect(result.output).toContain("not read first")
})

test("write succeeds after read, and creates new files", async () => {
  const files = new FileState()
  await writeFile(path.join(dir, "c.txt"), "old")
  await readTool.execute({ filePath: "c.txt" }, context(files))
  const overwrite = await writeTool.execute({ filePath: "c.txt", content: "new content" }, context(files))
  expect(overwrite.status).toBe("ok")
  expect(await Bun.file(path.join(dir, "c.txt")).text()).toBe("new content")

  const created = await writeTool.execute({ filePath: "sub/new.txt", content: "hello" }, context(files))
  expect(created.status).toBe("ok")
  expect(await Bun.file(path.join(dir, "sub/new.txt")).text()).toBe("hello")
})

test("edit applies a replacement after read", async () => {
  const files = new FileState()
  await writeFile(path.join(dir, "code.ts"), "export const x = 1\n")
  await readTool.execute({ filePath: "code.ts" }, context(files))
  const result = await editTool.execute(
    { filePath: "code.ts", oldString: "const x = 1", newString: "const x = 2" },
    context(files),
  )
  expect(result.status).toBe("ok")
  expect(await Bun.file(path.join(dir, "code.ts")).text()).toBe("export const x = 2\n")
})

test("edit falls back to fuzzy match on imprecise oldString", async () => {
  const files = new FileState()
  await writeFile(path.join(dir, "f.ts"), "function f() {\n    return 1\n}\n")
  await readTool.execute({ filePath: "f.ts" }, context(files))
  const result = await editTool.execute(
    { filePath: "f.ts", oldString: "function f() {\nreturn 1\n}", newString: "function f() {\n    return 2\n}" },
    context(files),
  )
  expect(result.status).toBe("ok")
  expect(await Bun.file(path.join(dir, "f.ts")).text()).toContain("return 2")
})
