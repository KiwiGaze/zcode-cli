import { test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { SessionStore, listSessions, loadSession } from "@/session/store"
import { createSession } from "@/session/session"
import { userMessage, type AssistantMessage, type ToolResultItem } from "@/session/messages"
import { okResult } from "@/tools/types"

let dataDir: string
let prevXdg: string | undefined

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "zcode-data-"))
  prevXdg = process.env["XDG_DATA_HOME"]
  process.env["XDG_DATA_HOME"] = dataDir
})
afterEach(async () => {
  if (prevXdg === undefined) delete process.env["XDG_DATA_HOME"]
  else process.env["XDG_DATA_HOME"] = prevXdg
  await rm(dataDir, { recursive: true, force: true })
})

test("append, list, and load round-trips items and rebuilds usage", async () => {
  const session = createSession("/work/project")
  const store = await SessionStore.open(session)

  const user = userMessage("m1", "hello world")
  const assistant: AssistantMessage = {
    type: "assistant",
    id: "m2",
    ts: 1,
    provider: "zai",
    model: "glm-5.2",
    parts: [
      { type: "text", text: "hi" },
      { type: "tool-call", callId: "c1", name: "read", input: { filePath: "a.txt" } },
    ],
    usage: { input: 30, output: 10, reasoning: 5, cachedInput: 2 },
    stopReason: "tool-calls",
  }
  const toolResult: ToolResultItem = { type: "tool-result", callId: "c1", name: "read", result: okResult("file body") }

  await store.appendItem(user)
  await store.appendItem(assistant)
  await store.appendItem(toolResult)

  const summaries = await listSessions("/work/project")
  expect(summaries).toHaveLength(1)
  expect(summaries[0]?.id).toBe(session.id)
  expect(summaries[0]?.preview).toBe("hello world")

  const loaded = await loadSession("/work/project", session.id)
  expect(loaded.session.items).toHaveLength(3)
  expect(loaded.session.items[0]?.type).toBe("user")
  expect(loaded.session.totalUsage.input).toBe(30)
  expect(loaded.session.totalUsage.output).toBe(10)
})

test("reopen appends without dropping earlier records", async () => {
  const session = createSession("/work/project")
  const store = await SessionStore.open(session)
  await store.appendItem(userMessage("m1", "first"))

  const reopened = await SessionStore.reopen("/work/project", session.id)
  await reopened.appendItem(userMessage("m2", "second"))

  const loaded = await loadSession("/work/project", session.id)
  const texts = loaded.session.items.map((item) => (item.type === "user" ? item.content[0]?.text : ""))
  expect(texts).toEqual(["first", "second"])
})

test("compaction records are collected separately from chat items", async () => {
  const session = createSession("/work/project")
  const store = await SessionStore.open(session)
  await store.appendItem(userMessage("m1", "hi"))
  await store.appendCompaction({ type: "compaction", summary: "did stuff", coversUpTo: "m1" })

  const loaded = await loadSession("/work/project", session.id)
  expect(loaded.session.items).toHaveLength(1)
  expect(loaded.compactions).toHaveLength(1)
  expect(loaded.compactions[0]?.summary).toBe("did stuff")
})
