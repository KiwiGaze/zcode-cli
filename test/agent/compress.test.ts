import { test, expect } from "bun:test"
import { z } from "zod"
import { compressForModel, CLEARED_PLACEHOLDER, SNIP_PLACEHOLDER, type CompressionOptions } from "@/agent/compress"
import { query } from "@/agent/query"
import { createSession } from "@/session/session"
import { userMessage, type AssistantMessage, type ChatItem, type ToolResultItem } from "@/session/messages"
import { defineTool, type AnyTool } from "@/tools/registry"
import { okResult } from "@/tools/types"
import type { AgentEvent } from "@/agent/events"
import { mockLLM } from "../support/mock-llm"
import { testConfig, withApiKey } from "../support/config"
import { testRuntime } from "../support/runtime"

const IDLE_MS = 300_000

interface AssistantSpec {
  ts?: number
  input?: number
  cachedInput?: number
  calls?: { callId: string; name: string; input: unknown }[]
}

function assistant(id: string, spec: AssistantSpec = {}): AssistantMessage {
  return {
    type: "assistant",
    id,
    ts: spec.ts ?? 9_000,
    provider: "zai",
    model: "glm-5.2",
    parts: (spec.calls ?? []).map((call) => ({ type: "tool-call", ...call })),
    usage: { input: spec.input ?? 0, output: 5, reasoning: 0, cachedInput: spec.cachedInput ?? 0 },
    stopReason: "tool-calls",
  }
}

function toolResult(callId: string, name: string, output: string): ToolResultItem {
  return { type: "tool-result", callId, name, result: okResult(output, `${name} result`) }
}

function options(over: Partial<CompressionOptions> = {}): CompressionOptions {
  return { usedTokens: 60, window: 100, now: 10_000, keepRecent: 3, idleMs: IDLE_MS, ...over }
}

function outputs(items: ChatItem[]): string[] {
  return items.filter((item) => item.type === "tool-result").map((item) => item.result.output)
}

/** Reads of `paths` in order, as the assistant tool-calls plus their results. */
function readTurns(paths: string[], outputSize = 200): ChatItem[] {
  const items: ChatItem[] = []
  paths.forEach((filePath, i) => {
    const callId = `c${i}`
    items.push(assistant(`a${i}`, { calls: [{ callId, name: "read", input: { filePath } }] }))
    items.push(toolResult(callId, "read", `${filePath}:${"x".repeat(outputSize)}`))
  })
  return items
}

async function collect(gen: AsyncGenerator<AgentEvent, void>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of gen) events.push(event)
  return events
}

test("tier 1 shrinks oversized results head+tail once the window is half full", () => {
  const items: ChatItem[] = [
    userMessage("u1", "go"),
    assistant("a1", { input: 60, calls: [{ callId: "c1", name: "write", input: { filePath: "a.txt" } }] }),
    toolResult("c1", "write", `HEAD${"x".repeat(100_000)}TAIL`),
  ]

  const shrunk = compressForModel(items, options({ usedTokens: 60 }))
  const output = outputs(shrunk.items)[0] ?? ""
  expect(shrunk.report.budgeted).toBe(1)
  expect(shrunk.report.savedChars).toBeGreaterThan(60_000)
  expect(output).toContain("[... budgeted:")
  expect(output.startsWith("HEAD")).toBe(true)
  expect(output.endsWith("TAIL")).toBe(true)
  expect(output.length).toBeLessThan(30_000)

  const belowThreshold = compressForModel(items, options({ usedTokens: 40 }))
  expect(belowThreshold.report.budgeted).toBe(0)
  expect(belowThreshold.items[2]).toBe(items[2])
})

test("no tier ever touches the protected prefix or the shape of the projection", () => {
  const items: ChatItem[] = [
    userMessage("u1", "first ask"),
    ...readTurns(["a.ts", "b.ts", "a.ts", "c.ts", "d.ts"], 50_000),
    userMessage("u2", "second ask"),
  ]

  // utilization above the hot override plus an idle gap: every tier is allowed to fire
  const result = compressForModel(items, options({ usedTokens: 90, now: 9_000 + IDLE_MS }))

  expect(result.report.budgeted + result.report.snipped + result.report.cleared).toBeGreaterThan(0)
  expect(result.items).toHaveLength(items.length)
  items.forEach((item, index) => {
    const after = result.items[index]
    if (item.type === "tool-result") {
      expect(after?.type).toBe("tool-result")
      expect(after?.type === "tool-result" ? after.callId : "").toBe(item.callId)
      expect(after?.type === "tool-result" ? after.name : "").toBe(item.name)
      return
    }
    expect(after).toBe(item)
  })
})

test("tool calls keep their results after compression", () => {
  const items: ChatItem[] = [userMessage("u1", "go"), ...readTurns(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"], 40_000)]
  const result = compressForModel(items, options({ usedTokens: 90, now: 9_000 + IDLE_MS }))

  const calls = items.flatMap((item) =>
    item.type === "assistant" ? item.parts.filter((part) => part.type === "tool-call").map((part) => part.callId) : [],
  )
  expect(calls.length).toBe(5)
  for (const callId of calls) {
    const before = items.findIndex((item) => item.type === "tool-result" && item.callId === callId)
    const after = result.items.findIndex((item) => item.type === "tool-result" && item.callId === callId)
    expect(after).toBe(before)
  }
})

test("tier 2 leaves a hot prefix alone until utilization passes the override", () => {
  const base = readTurns(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"])
  const hot: ChatItem[] = [userMessage("u1", "go"), ...base, assistant("last", { input: 100, cachedInput: 40 })]

  expect(compressForModel(hot, options({ usedTokens: 65 })).report.snipped).toBe(0)
  expect(compressForModel(hot, options({ usedTokens: 80 })).report.snipped).toBe(2)

  const cold: ChatItem[] = [userMessage("u1", "go"), ...base, assistant("last", { input: 100, ts: 1_000 })]
  expect(compressForModel(cold, options({ usedTokens: 65, now: 1_000 + IDLE_MS })).report.snipped).toBe(2)

  // nothing reported usage yet, so there is no cached prefix worth protecting
  const fresh: ChatItem[] = [userMessage("u1", "go"), ...base]
  expect(compressForModel(fresh, options({ usedTokens: 65 })).report.snipped).toBe(2)
})

test("tier 2 snips superseded reads of the same file and keeps the newest", () => {
  const items: ChatItem[] = [userMessage("u1", "go"), ...readTurns(["a.ts", "b.ts", "a.ts"])]
  const result = compressForModel(items, options({ usedTokens: 65, keepRecent: 10 }))

  const after = outputs(result.items)
  expect(result.report.snipped).toBe(1)
  expect(after[0]).toBe(SNIP_PLACEHOLDER)
  expect(after[1]).toContain("b.ts")
  expect(after[2]).toContain("a.ts")
})

test("tier 3 clears older results of any tool only after an idle gap", () => {
  const items: ChatItem[] = [
    userMessage("u1", "go"),
    assistant("a1", { ts: 1_000, calls: [{ callId: "c1", name: "write", input: {} }] }),
    toolResult("c1", "write", "wrote one".repeat(20)),
    toolResult("c2", "write", "wrote two".repeat(20)),
    toolResult("c3", "write", "wrote three".repeat(20)),
    toolResult("c4", "write", "wrote four".repeat(20)),
  ]

  const busy = compressForModel(items, options({ usedTokens: 30, now: 1_000 + IDLE_MS - 1 }))
  expect(busy.report.cleared).toBe(0)

  const idle = compressForModel(items, options({ usedTokens: 30, now: 1_000 + IDLE_MS }))
  expect(idle.report.cleared).toBe(1)
  expect(outputs(idle.items)[0]).toBe(CLEARED_PLACEHOLDER)
  expect(outputs(idle.items)[3]).toContain("wrote four")
})

test("compression leaves its input untouched and settles after one pass", () => {
  const items: ChatItem[] = [
    userMessage("u1", "go"),
    ...readTurns(["a.ts", "b.ts", "a.ts", "c.ts", "d.ts"], 40_000),
  ]
  const snapshot = structuredClone(items)

  const first = compressForModel(items, options({ usedTokens: 90, now: 9_000 + IDLE_MS }))
  expect(items).toEqual(snapshot)

  const second = compressForModel(first.items, options({ usedTokens: 90, now: 9_000 + IDLE_MS }))
  expect(second.report).toEqual({ budgeted: 0, snipped: 0, cleared: 0, savedChars: 0 })
  expect(second.items).toEqual(first.items)
})

test("the model receives compressed context while session history stays pristine", async () => {
  const restore = withApiKey()
  try {
    const config = testConfig({
      models: { "glm-5.2": { context: 1000, maxOutput: 100 } },
      spill: { enabled: false, thresholdBytes: 30_720, previewLines: 200 },
    })
    const session = createSession("/tmp/zcode-test")
    const output = `HEAD${"x".repeat(60_000)}TAIL`
    const dumpTool: AnyTool = defineTool<{ q: string }>({
      name: "dump",
      description: "returns a lot of text",
      inputSchema: z.object({ q: z.string() }),
      permission: () => null,
      execute: async () => okResult(output, "dump"),
    })
    const runtime = testRuntime(config, [dumpTool])
    const llm = mockLLM([
      { text: "dumping", toolCalls: [{ callId: "c1", name: "dump", input: { q: "all" } }], usage: { input: 800 } },
      { text: "done", usage: { input: 850 } },
    ])

    const events = await collect(
      query({
        prompt: "dump everything",
        session,
        config,
        runtime,
        signal: new AbortController().signal,
        deps: { llm: llm.fn },
      }),
    )

    const compression = events.find((event) => event.type === "compression")
    expect(compression?.type === "compression" ? compression.budgeted : 0).toBe(1)

    const sent = llm.calls[1]?.messages.find((item) => item.type === "tool-result")
    expect(sent?.type === "tool-result" ? sent.result.output : "").toContain("[... budgeted:")
    expect(sent?.type === "tool-result" ? sent.result.output.length : 0).toBeLessThan(20_000)

    const stored = session.items.find((item) => item.type === "tool-result")
    expect(stored?.type === "tool-result" ? stored.result.output : "").toBe(output)
  } finally {
    restore()
  }
})
