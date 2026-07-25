import { test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { z } from "zod"
import { query } from "@/agent/query"
import { buildSystemPrompt } from "@/agent/system"
import { compact, estimatePromptTokens, lastPromptTokens, projectForModel, shouldCompact } from "@/agent/compact"
import type { AgentEvent } from "@/agent/events"
import { AppController } from "@/ui/controller"
import { createSession, type Session } from "@/session/session"
import { userMessage, type AssistantMessage, type ChatItem } from "@/session/messages"
import { SessionStore, loadSession, type CompactionRecord } from "@/session/store"
import { defineTool, type AnyTool } from "@/tools/registry"
import { okResult, type ToolResult } from "@/tools/types"
import { mockLLM, type MockCall } from "../support/mock-llm"
import { testConfig, withApiKey } from "../support/config"
import { testRuntime } from "../support/runtime"

/** Over the 30 KB spill threshold, and past the 200-line preview. */
const HUGE = Array.from({ length: 700 }, (_, i) => `huge line ${i} ${"h".repeat(50)}`).join("\n")
/** Under the spill threshold, over tier 1's aggressive char budget. */
const BIG = `BIG${"b".repeat(25_000)}`

let dataDir: string
let prevXdg: string | undefined
let restoreKey: () => void

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "zcode-context-"))
  prevXdg = process.env["XDG_DATA_HOME"]
  process.env["XDG_DATA_HOME"] = dataDir
  restoreKey = withApiKey()
})
afterEach(async () => {
  restoreKey()
  if (prevXdg === undefined) delete process.env["XDG_DATA_HOME"]
  else process.env["XDG_DATA_HOME"] = prevXdg
  await rm(dataDir, { recursive: true, force: true })
})

/** A tiny window plus a compaction line that never trips, so tests drive utilization directly. */
function contextConfig(threshold = 1) {
  return testConfig({
    models: { "glm-5.2": { context: 1000, maxOutput: 100 } },
    compaction: { threshold },
  })
}

function textTool(name: string, output: string): AnyTool {
  return defineTool<{ q?: string }>({
    name,
    description: `returns ${name} output`,
    inputSchema: z.object({ q: z.string().optional() }),
    permission: () => null,
    execute: async () => okResult(output, name),
  })
}

function abortingTool(controller: AbortController): AnyTool {
  return defineTool<{ q?: string }>({
    name: "slow",
    description: "interrupted mid-flight",
    inputSchema: z.object({ q: z.string().optional() }),
    permission: () => null,
    execute: async (): Promise<ToolResult> => {
      controller.abort()
      return { status: "aborted", output: "tool interrupted" }
    },
  })
}

function assistantItem(id: string, text: string, input: number): AssistantMessage {
  return {
    type: "assistant",
    id,
    ts: Date.now(),
    provider: "zai",
    model: "glm-5.2",
    parts: [{ type: "text", text }],
    usage: { input, output: 5, reasoning: 0, cachedInput: 0 },
    stopReason: "end",
  }
}

async function collect(gen: AsyncGenerator<AgentEvent, void>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of gen) events.push(event)
  return events
}

function headParts(call: MockCall | undefined): string[] {
  const first = call?.messages[0]
  return first?.type === "user" ? first.content.map((part) => part.text) : []
}

function resultOutput(call: MockCall | undefined, callId: string): string {
  const item = call?.messages.find((entry) => entry.type === "tool-result" && entry.callId === callId)
  return item?.type === "tool-result" ? item.result.output : ""
}

function storedOutput(session: Session, callId: string): string {
  const item = session.items.find((entry) => entry.type === "tool-result" && entry.callId === callId)
  return item?.type === "tool-result" ? item.result.output : ""
}

function unpairedCalls(items: ChatItem[]): string[] {
  const results = new Set(items.filter((item) => item.type === "tool-result").map((item) => item.callId))
  return items
    .flatMap((item) => (item.type === "assistant" ? item.parts : []))
    .filter((part) => part.type === "tool-call")
    .map((part) => part.callId)
    .filter((callId) => !results.has(callId))
}

test("one request carries the compaction fold, tier rewrites, and the context block in order", async () => {
  const config = contextConfig()
  const session = createSession("/work/app")
  session.items = [userMessage("u1", "first ask"), assistantItem("a1", "did the first thing", 900)]
  const runtime = testRuntime(config, [textTool("big", BIG)])
  runtime.compactions = [{ type: "compaction", summary: "earlier work", coversUpTo: "a1" }]
  const llm = mockLLM([
    { text: "looking", toolCalls: [{ callId: "c1", name: "big", input: {} }], usage: { input: 900 } },
    { text: "done", usage: { input: 900 } },
  ])

  await collect(
    query({
      prompt: "second ask",
      session,
      config,
      runtime,
      signal: new AbortController().signal,
      deps: { llm: llm.fn },
    }),
  )

  const parts = headParts(llm.calls[1])
  expect(parts[0]).toContain("<system-reminder>")
  expect(parts[1]).toContain("<conversation-summary>")
  expect(parts[1]).toContain("earlier work")
  expect(llm.calls[1]?.system).toBe(buildSystemPrompt())
  expect(resultOutput(llm.calls[1], "c1")).toContain("[... budgeted:")
  expect(resultOutput(llm.calls[1], "c1").length).toBeLessThan(BIG.length)
})

test("spill, compression, and the context block leave history, store, and transcript pristine", async () => {
  const config = contextConfig()
  const session = createSession("/work/app")
  const runtime = testRuntime(config, [textTool("huge", HUGE), textTool("big", BIG)])
  const llm = mockLLM([
    {
      text: "working",
      toolCalls: [
        { callId: "c1", name: "huge", input: {} },
        { callId: "c2", name: "big", input: {} },
      ],
      usage: { input: 900 },
    },
    { text: "done", usage: { input: 900 } },
  ])
  const store = await SessionStore.open(session)
  const controller = new AppController({ session, config, runtime, store, deps: { llm: llm.fn } })

  await controller.submit("do the thing")

  // history keeps the spill placeholder (write time) but no compression placeholder (projection time)
  expect(storedOutput(session, "c1")).toContain("Result too large")
  expect(storedOutput(session, "c1")).not.toContain("huge line 699")
  expect(storedOutput(session, "c2")).toBe(BIG)

  const reloaded = await loadSession(session.cwd, session.id)
  expect(reloaded.session.items).toEqual(session.items)

  controller.loadFrom(reloaded, store)
  const transcript = JSON.stringify(controller.getSnapshot().history)
  expect(transcript).not.toContain("<system-reminder>")
  expect(transcript).not.toContain("[... budgeted:")

  expect(headParts(llm.calls[1])[0]).toContain("<system-reminder>")
  expect(resultOutput(llm.calls[1], "c1")).toContain("Result too large")
  expect(resultOutput(llm.calls[1], "c2")).toContain("[... budgeted:")
})

test("a resumed session rebuilds usage and runs the whole pipeline again", async () => {
  const config = contextConfig()
  const session = createSession("/work/app")
  const runtime = testRuntime(config, [textTool("huge", HUGE), textTool("big", BIG)])
  const firstLlm = mockLLM([
    { text: "reading", toolCalls: [{ callId: "c1", name: "huge", input: {} }], usage: { input: 900 } },
    { text: "done", usage: { input: 900 } },
  ])
  const store = await SessionStore.open(session)
  const controller = new AppController({ session, config, runtime, store, deps: { llm: firstLlm.fn } })
  await controller.submit("first ask")

  const lastAssistant = session.items.filter((item) => item.type === "assistant").at(-1)
  const record: CompactionRecord = { type: "compaction", summary: "earlier work", coversUpTo: lastAssistant?.id ?? "" }
  await store.appendCompaction(record)

  const reloaded = await loadSession(session.cwd, session.id)
  expect(reloaded.session.totalUsage).toEqual(session.totalUsage)
  expect(reloaded.compactions).toHaveLength(1)

  const resumedRuntime = testRuntime(config, [textTool("big", BIG)])
  resumedRuntime.compactions = reloaded.compactions
  const secondLlm = mockLLM([
    { text: "looking", toolCalls: [{ callId: "c2", name: "big", input: {} }], usage: { input: 900 } },
    { text: "done", usage: { input: 900 } },
  ])
  await collect(
    query({
      prompt: "second ask",
      session: reloaded.session,
      config,
      runtime: resumedRuntime,
      signal: new AbortController().signal,
      deps: { llm: secondLlm.fn },
    }),
  )

  const parts = headParts(secondLlm.calls[1])
  expect(parts[0]).toContain("<system-reminder>")
  expect(parts[1]).toContain("earlier work")
  expect(resultOutput(secondLlm.calls[1], "c2")).toContain("[... budgeted:")
})

test("an interrupted turn stays paired, compactable, and continuable", async () => {
  const config = contextConfig()
  const session = createSession("/work/app")
  const aborter = new AbortController()
  const runtime = testRuntime(config, [abortingTool(aborter), textTool("big", BIG)])
  const llm = mockLLM([
    { text: "first reply", usage: { input: 100 } },
    {
      text: "working",
      toolCalls: [
        { callId: "c1", name: "slow", input: {} },
        { callId: "c2", name: "big", input: {} },
      ],
      usage: { input: 900 },
    },
  ])

  await collect(
    query({ prompt: "first ask", session, config, runtime, signal: new AbortController().signal, deps: { llm: llm.fn } }),
  )
  await collect(
    query({ prompt: "second ask", session, config, runtime, signal: aborter.signal, deps: { llm: llm.fn } }),
  )

  expect(unpairedCalls(session.items)).toEqual([])

  const compactLlm = mockLLM([{ text: "## Goal\nkeep going" }])
  const record = await compact(session, config, runtime.compactions, new AbortController().signal, {
    llm: compactLlm.fn,
  })
  expect(record).not.toBeNull()

  const nextLlm = mockLLM([{ text: "continuing", usage: { input: 900 } }])
  await collect(
    query({
      prompt: "third ask",
      session,
      config,
      runtime,
      signal: new AbortController().signal,
      deps: { llm: nextLlm.fn },
    }),
  )
  expect(unpairedCalls(nextLlm.calls[0]?.messages ?? [])).toEqual([])
})

test("compaction, compression, and the status gauge read one utilization", async () => {
  const config = contextConfig(0.8)
  const session = createSession("/work/app")
  const runtime = testRuntime(config, [textTool("big", BIG)])
  const llm = mockLLM([
    { text: "looking", toolCalls: [{ callId: "c1", name: "big", input: {} }], usage: { input: 100 } },
    { text: "done", usage: { input: 100 } },
  ])
  const controller = new AppController({ session, config, runtime, deps: { llm: llm.fn } })

  await controller.submit("do the thing")

  // the request that was actually sent stayed small, so the paid compaction line is not crossed …
  expect(lastPromptTokens(session, runtime.compactions)).toBe(100)
  expect(shouldCompact(session, config, runtime.compactions)).toBe(false)
  expect(controller.getSnapshot().status.contextTokens).toBe(100)
  // … even though the raw history would estimate well past it
  expect(estimatePromptTokens(projectForModel(session, runtime.compactions))).toBeGreaterThan(800)
})

test("a request after compaction keeps the same context block and still compresses the tail", async () => {
  const config = contextConfig()
  const session = createSession("/work/app")
  const runtime = testRuntime(config, [textTool("big", BIG)])
  const firstLlm = mockLLM([{ text: "hello there", usage: { input: 100 } }])
  await collect(
    query({ prompt: "first ask", session, config, runtime, signal: new AbortController().signal, deps: { llm: firstLlm.fn } }),
  )
  const blockBefore = headParts(firstLlm.calls[0])[0] ?? ""
  expect(blockBefore).toContain("<system-reminder>")

  const firstAssistant = session.items.find((item) => item.type === "assistant")
  runtime.compactions = [
    { type: "compaction", summary: "earlier work", coversUpTo: firstAssistant?.id ?? "" },
  ]

  const secondLlm = mockLLM([
    { text: "looking", toolCalls: [{ callId: "c1", name: "big", input: {} }], usage: { input: 900 } },
    { text: "done", usage: { input: 900 } },
  ])
  await collect(
    query({ prompt: "second ask", session, config, runtime, signal: new AbortController().signal, deps: { llm: secondLlm.fn } }),
  )

  const parts = headParts(secondLlm.calls[1])
  expect(parts[0]).toBe(blockBefore)
  expect(parts[1]).toContain("<conversation-summary>")
  expect(resultOutput(secondLlm.calls[1], "c1")).toContain("[... budgeted:")
})
