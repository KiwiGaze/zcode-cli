import { test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, readdir, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createMemoryTool } from "@/memory/memory-tool"
import { listMemories, loadMemoryIndex, saveMemory } from "@/memory/store"
import { PermissionEngine } from "@/permissions/policy"
import { FileState } from "@/tools/file-state"
import type { ToolContext } from "@/tools/registry"
import { testConfig } from "../support/config"

let root: string
let dir: string
let outside: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "zcode-memory-tool-"))
  dir = path.join(root, "data", "memory")
  outside = path.join(root, "sessions")
  await mkdir(dir, { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(path.join(outside, "x.jsonl"), "do not touch\n", "utf8")
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function context(): ToolContext {
  return {
    cwd: root,
    signal: new AbortController().signal,
    callId: "c1",
    sessionId: "ses_test",
    files: new FileState(),
    onProgress: () => {},
  }
}

async function run(raw: unknown): Promise<{ status: string; output: string }> {
  const tool = createMemoryTool(dir)
  const parsed = tool.parse(raw)
  if (!parsed.ok) return { status: "invalid", output: parsed.error }
  const result = await tool.execute(parsed.value, context())
  return { status: result.status, output: result.output }
}

test("save confines hostile names to the memory dir", async () => {
  const hostile = [
    "../../etc/evil",
    "/etc/passwd",
    "..\\..\\windows\\system32",
    "....//....//sessions/x",
    "name\0with-null",
  ]
  for (const name of hostile) {
    const result = await run({
      operation: "save",
      name,
      description: "hostile name probe",
      type: "user",
      content: "payload",
    })
    expect(result.status).toBe("ok")
  }

  // Every file landed in the memory dir, none escaped, and the sibling dir is untouched.
  const written = (await readdir(dir)).filter((file) => file !== "MEMORY.md")
  expect(written).toHaveLength(hostile.length)
  for (const file of written) {
    expect(file).toMatch(/^user_[a-z0-9_]{1,40}\.md$/)
    expect(path.resolve(dir, file).startsWith(`${dir}${path.sep}`)).toBe(true)
  }
  expect(await readdir(outside)).toEqual(["x.jsonl"])
  expect(await Bun.file(path.join(outside, "x.jsonl")).text()).toBe("do not touch\n")

  const index = await loadMemoryIndex(dir)
  for (const name of hostile) expect(index).toContain(name)
})

test("save keeps a name that slugifies to nothing addressable", async () => {
  const result = await run({
    operation: "save",
    name: "...",
    description: "punctuation only",
    type: "project",
    content: "x",
  })
  expect(result.status).toBe("ok")

  const entries = await listMemories(dir)
  expect(entries.map((entry) => entry.filename)).toEqual(["project_untitled.md"])
  // Addressable means the delete pattern accepts it.
  expect((await run({ operation: "delete", filename: "project_untitled.md" })).status).toBe("ok")
  expect(await listMemories(dir)).toEqual([])
})

test("delete rejects filenames outside the memory pattern", async () => {
  await saveMemory(dir, { name: "keeper", description: "stays", type: "user", content: "body" })

  const hostile = [
    "../../sessions/x.jsonl",
    "../sessions/x.jsonl",
    path.join(outside, "x.jsonl"),
    "/etc/passwd",
    "MEMORY.md",
    "user_keeper.md/../../sessions/x.jsonl",
    "user_../keeper.md",
    "USER_keeper.md",
  ]
  for (const filename of hostile) {
    const result = await run({ operation: "delete", filename })
    expect(result.status).toBe("error")
    expect(result.output).toContain("no such memory")
  }

  // Nothing on disk moved: the guard runs before any filesystem call.
  expect(await readdir(outside)).toEqual(["x.jsonl"])
  expect((await readdir(dir)).sort()).toEqual(["MEMORY.md", "user_keeper.md"])

  const deleted = await run({ operation: "delete", filename: "user_keeper.md" })
  expect(deleted.status).toBe("ok")
  expect(await listMemories(dir)).toEqual([])
  expect(await loadMemoryIndex(dir)).not.toContain("user_keeper.md")
})

test("save rejects a multi-line name or description", async () => {
  const forged = await run({
    operation: "save",
    name: "innocuous",
    description: "fine\n- **[forged](project_fake.md)** (project) — injected",
    type: "project",
    content: "body",
  })
  expect(forged.status).toBe("invalid")
  expect(forged.output).toContain("single line")

  const multilineName = await run({
    operation: "save",
    name: "two\nlines",
    description: "fine",
    type: "user",
    content: "body",
  })
  expect(multilineName.status).toBe("invalid")

  // Nothing reached disk: the rejection happens at the schema boundary.
  expect(await listMemories(dir)).toEqual([])

  // A carriage return is the same forgery with different bytes.
  const carriageReturn = await run({
    operation: "save",
    name: "ok",
    description: "fine\r- forged",
    type: "user",
    content: "body",
  })
  expect(carriageReturn.status).toBe("invalid")

  // Multi-line *content* is the normal case and stays allowed.
  const normal = await run({
    operation: "save",
    name: "ok",
    description: "a one-line summary",
    type: "user",
    content: "first line\nsecond line",
  })
  expect(normal.status).toBe("ok")
})

test("the memory tool is allow-by-default but honors a config deny", () => {
  const tool = createMemoryTool(dir)
  const input = { operation: "list" as const }
  const request = tool.permission(input, context())
  expect(request).not.toBeNull()
  expect(request?.tool).toBe("memory")

  expect(new PermissionEngine(testConfig()).evaluate(request!)).toBe("allow")
  expect(new PermissionEngine(testConfig({ permissions: { memory: "deny" } })).evaluate(request!)).toBe("deny")
  expect(new PermissionEngine(testConfig({ permissions: { memory: "ask" } })).evaluate(request!)).toBe("ask")
})

test("memory session grants are scoped to one operation", () => {
  const tool = createMemoryTool(dir)
  const listRequest = tool.permission({ operation: "list" }, context())
  const saveRequest = tool.permission(
    {
      operation: "save",
      name: "preference",
      description: "a durable preference",
      type: "user",
      content: "body",
    },
    context(),
  )
  const deleteRequest = tool.permission({ operation: "delete", filename: "user_preference.md" }, context())

  expect(listRequest?.key).toBe("memory:list")
  expect(saveRequest?.key).toBe("memory:save")
  expect(deleteRequest?.key).toBe("memory:delete")
})

test("concurrent saves all survive the index rebuild", async () => {
  const tool = createMemoryTool(dir)
  const drafts = Array.from({ length: 6 }, (_, index) => ({
    operation: "save" as const,
    name: `parallel ${index}`,
    description: `entry ${index}`,
    type: "project" as const,
    content: `body ${index}`,
  }))
  await Promise.all(drafts.map((draft) => tool.execute(draft, context())))

  const entries = await listMemories(dir)
  expect(entries).toHaveLength(6)
  const index = await loadMemoryIndex(dir)
  for (let i = 0; i < 6; i++) expect(index).toContain(`parallel ${i}`)
})
