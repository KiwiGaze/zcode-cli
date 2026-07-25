import { test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { z } from "zod"
import { query } from "@/agent/query"
import { readSpillInfo, spillToolResult } from "@/agent/spill"
import { sessionDir } from "@/config/paths"
import { createSession } from "@/session/session"
import { SessionStore, loadSession } from "@/session/store"
import type { Session } from "@/session/session"
import { readTool } from "@/tools/read"
import { FileState } from "@/tools/file-state"
import { defineTool, type AnyTool, type ToolContext } from "@/tools/registry"
import { okResult, type ToolResult } from "@/tools/types"
import type { AgentEvent } from "@/agent/events"
import { mockLLM } from "../support/mock-llm"
import { testConfig, withApiKey } from "../support/config"
import { testRuntime } from "../support/runtime"

let dataDir: string
let prevXdg: string | undefined

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "zcode-spill-"))
  prevXdg = process.env["XDG_DATA_HOME"]
  process.env["XDG_DATA_HOME"] = dataDir
})
afterEach(async () => {
  if (prevXdg === undefined) delete process.env["XDG_DATA_HOME"]
  else process.env["XDG_DATA_HOME"] = prevXdg
  await rm(dataDir, { recursive: true, force: true })
})

function bigOutput(lines: number): string {
  return Array.from({ length: lines }, (_, i) => `line ${i} ${"x".repeat(60)}`).join("\n")
}

function spillDir(session: Session): string {
  return path.join(sessionDir(session.cwd), session.id, "tool-results")
}

function hugeTool(output: string): AnyTool {
  return defineTool<{ q: string }>({
    name: "huge",
    description: "returns a large result",
    inputSchema: z.object({ q: z.string() }),
    permission: () => null,
    execute: async () => okResult(output, "huge result"),
  })
}

async function collect(gen: AsyncGenerator<AgentEvent, void>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of gen) events.push(event)
  return events
}

test("results above the threshold spill to a session-scoped file", async () => {
  const config = testConfig()
  const session = createSession("/work/spill-project")
  const output = bigOutput(700)
  const original: ToolResult = okResult(output, "huge result")

  const spilled = await spillToolResult(session, "call_abc", original, config)
  const info = readSpillInfo(spilled.metadata)

  expect(info).not.toBeNull()
  expect(info?.bytes).toBe(Buffer.byteLength(output, "utf8"))
  expect(info?.lines).toBe(700)
  expect(path.dirname(info?.path ?? "")).toBe(spillDir(session))
  expect(path.basename(info?.path ?? "")).toMatch(/^call_abc-[0-9a-f]{16}\.txt$/)
  expect(await Bun.file(info?.path ?? "").text()).toBe(output)

  expect(spilled.output).toContain("Result too large")
  expect(spilled.output).toContain(`${info?.path}`)
  expect(spilled.output).toContain("read tool")
  expect(spilled.output).toContain("Preview (first 200 lines):")
  expect(spilled.output).toContain("line 0 ")
  expect(spilled.output).not.toContain("line 300 ")
  expect(spilled.output.length).toBeLessThan(output.length)
  expect(spilled.title).toBe("huge result")

  // the caller's result object is untouched
  expect(original.output).toBe(output)
  expect(original.metadata).toBeUndefined()
})

test("the threshold is measured in bytes and only successful results spill", async () => {
  const config = testConfig({ spill: { enabled: true, thresholdBytes: 1024, previewLines: 5 } })
  const session = createSession("/work/spill-project")

  const under = okResult("x".repeat(1024))
  expect(await spillToolResult(session, "c-under", under, config)).toBe(under)

  // 600 two-byte characters are 1200 bytes but only 600 chars
  const multibyte = okResult("é".repeat(600))
  const spilled = await spillToolResult(session, "c-multi", multibyte, config)
  expect(readSpillInfo(spilled.metadata)?.bytes).toBe(1200)

  const failed: ToolResult = { status: "error", output: "x".repeat(4096) }
  expect(await spillToolResult(session, "c-error", failed, config)).toBe(failed)
  const denied: ToolResult = { status: "denied", output: "x".repeat(4096) }
  expect(await spillToolResult(session, "c-denied", denied, config)).toBe(denied)

  const written = await readdir(spillDir(session))
  expect(written).toHaveLength(1)
  expect(written[0]).toMatch(/^c-multi-[0-9a-f]{16}\.txt$/)
})

test("the preview is capped even for a pathological single-line result", async () => {
  const config = testConfig()
  const session = createSession("/work/spill-project")
  const output = "y".repeat(500_000)

  const spilled = await spillToolResult(session, "c-one-line", okResult(output), config)
  const info = readSpillInfo(spilled.metadata)

  expect(await Bun.file(info?.path ?? "").text()).toBe(output)
  expect(spilled.output.length).toBeLessThan(9_000)
  expect(spilled.output).toContain("preview truncated")
})

test("call ids that sanitize to the same characters still get separate files", async () => {
  const config = testConfig()
  const session = createSession("/work/spill-project")

  // "call#1" and "call!1" both sanitize to "call_1"; neither may overwrite the other
  const [first, second] = await Promise.all([
    spillToolResult(session, "call#1", okResult(bigOutput(700)), config),
    spillToolResult(session, "call!1", okResult(bigOutput(800)), config),
  ])

  const firstPath = readSpillInfo(first.metadata)?.path ?? ""
  const secondPath = readSpillInfo(second.metadata)?.path ?? ""
  expect(firstPath).not.toBe(secondPath)
  expect(path.basename(firstPath).startsWith("call_1-")).toBe(true)
  expect(path.basename(secondPath).startsWith("call_1-")).toBe(true)
  expect((await Bun.file(firstPath).text()).split("\n")).toHaveLength(700)
  expect((await Bun.file(secondPath).text()).split("\n")).toHaveLength(800)

  // a path-hostile id still cannot escape the tool-results directory
  const hostile = await spillToolResult(session, "../../escape", okResult(bigOutput(700)), config)
  expect(path.dirname(readSpillInfo(hostile.metadata)?.path ?? "")).toBe(spillDir(session))
})

test("spilled placeholders reach the model and survive a session round-trip", async () => {
  const restore = withApiKey()
  try {
    const config = testConfig()
    const session = createSession("/work/spill-project")
    const output = bigOutput(700)
    const runtime = testRuntime(config, [hugeTool(output)])
    const llm = mockLLM([
      { text: "reading", toolCalls: [{ callId: "c1", name: "huge", input: { q: "everything" } }] },
      { text: "done" },
    ])
    const store = await SessionStore.open(session)

    await collect(
      query({
        prompt: "fetch a lot",
        session,
        config,
        runtime,
        signal: new AbortController().signal,
        deps: { llm: llm.fn },
      }),
    )
    for (const item of session.items) await store.appendItem(item)

    const stored = session.items.find((item) => item.type === "tool-result")
    expect(stored?.type === "tool-result" ? stored.result.output : "").toContain("Result too large")
    expect(stored?.type === "tool-result" ? stored.result.output.length : 0).toBeLessThan(output.length)

    const sent = llm.calls[1]?.messages.find((item) => item.type === "tool-result")
    expect(sent?.type === "tool-result" ? sent.result.output : "").toContain("Result too large")
    expect(JSON.stringify(llm.calls[1]?.messages)).not.toContain("line 300 ")

    const reloaded = await loadSession(session.cwd, session.id)
    const replayed = reloaded.session.items.find((item) => item.type === "tool-result")
    expect(replayed?.type === "tool-result" ? replayed.result.output : "").toBe(
      stored?.type === "tool-result" ? stored.result.output : "",
    )
    expect(readSpillInfo(replayed?.type === "tool-result" ? replayed.result.metadata : undefined)).not.toBeNull()
  } finally {
    restore()
  }
})

test("the re-read hint resolves through the real read tool", async () => {
  const config = testConfig()
  const session = createSession("/work/spill-project")
  const spilled = await spillToolResult(session, "c-read-back", okResult(bigOutput(700)), config)
  const spillPath = readSpillInfo(spilled.metadata)?.path ?? ""

  const ctx: ToolContext = {
    cwd: session.cwd,
    signal: new AbortController().signal,
    callId: "c-read-back",
    sessionId: session.id,
    files: new FileState(),
    onProgress: () => {},
  }
  const result = await readTool.execute({ filePath: spillPath, offset: 300, limit: 20 }, ctx)

  expect(result.status).toBe("ok")
  expect(result.output).toContain("line 300 ")
})

test("spill disabled leaves every result untouched", async () => {
  const config = testConfig({ spill: { enabled: false, thresholdBytes: 30_720, previewLines: 200 } })
  const session = createSession("/work/spill-project")
  const original = okResult(bigOutput(700))

  expect(await spillToolResult(session, "c-off", original, config)).toBe(original)
  await expect(readdir(spillDir(session))).rejects.toThrow()
})
