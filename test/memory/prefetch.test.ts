import { test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { z } from "zod"
import { query } from "@/agent/query"
import { createSession } from "@/session/session"
import { createMemorySession } from "@/memory/recall"
import { saveMemory } from "@/memory/store"
import { defineTool, type AnyTool } from "@/tools/registry"
import { okResult } from "@/tools/types"
import type { AgentEvent } from "@/agent/events"
import type { ChatItem } from "@/session/messages"
import type { CompleteFn, CompleteRequest } from "@/llm/complete"
import { mockLLM } from "../support/mock-llm"
import { testConfig, withApiKey } from "../support/config"
import { testRuntime } from "../support/runtime"

const MEMORY_BODY = "The user always runs bun test before pushing."

let dir: string
let restoreKey: () => void

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "zcode-memory-prefetch-"))
  restoreKey = withApiKey()
  await saveMemory(dir, {
    name: "push habits",
    description: "how the user ships",
    type: "user",
    content: MEMORY_BODY,
  })
})
afterEach(async () => {
  restoreKey()
  await rm(dir, { recursive: true, force: true })
})

async function collect(gen: AsyncGenerator<AgentEvent, void>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of gen) events.push(event)
  return events
}

function messageText(items: ChatItem[]): string {
  return items
    .map((item) => {
      if (item.type === "user") return item.content.map((part) => part.text).join("")
      if (item.type === "assistant") return item.parts.map((part) => ("text" in part ? part.text : "")).join("")
      return item.result.output
    })
    .join("\n")
}

interface Gate {
  complete: CompleteFn
  calls: CompleteRequest[]
  release: () => void
}

/** A selector that answers only once the test releases it, so settle timing is the test's choice. */
function gatedSelector(): Gate {
  const calls: CompleteRequest[] = []
  let release!: () => void
  const opened = new Promise<void>((resolve) => {
    release = resolve
  })
  const complete: CompleteFn = async (request) => {
    calls.push(request)
    await opened
    return JSON.stringify({ selected_memories: ["user_push_habits.md"] })
  }
  return { complete, calls, release }
}

/** Yield the event loop so background recall can finish before the next assertion. */
async function drainBackground(ticks = 30): Promise<void> {
  for (let i = 0; i < ticks; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

function waitTool(onRun: () => Promise<void>): AnyTool {
  return defineTool<{ text: string }>({
    name: "echo",
    description: "echo text back",
    inputSchema: z.object({ text: z.string() }),
    permission: () => null,
    execute: async (input) => {
      await onRun()
      return okResult(`echoed: ${input.text}`)
    },
  })
}

test("recall settling mid-turn is injected into the next LLM request of that turn", async () => {
  const gate = gatedSelector()
  const config = testConfig()
  const memory = createMemorySession({ config, dir, complete: gate.complete })
  const session = createSession("/tmp/zcode-test")
  const runtime = testRuntime(config, [
    waitTool(async () => {
      // The turn is mid-flight here: releasing now settles the recall between iterations.
      gate.release()
      await drainBackground()
    }),
  ])
  const llm = mockLLM([
    { text: "checking", toolCalls: [{ callId: "c1", name: "echo", input: { text: "hi" } }] },
    { text: "done" },
  ])

  const events = await collect(
    query({
      prompt: "how should I ship this change",
      session,
      config,
      runtime,
      signal: new AbortController().signal,
      deps: { llm: llm.fn, memory },
    }),
  )

  expect(llm.calls).toHaveLength(2)
  expect(messageText(llm.calls[0]!.messages)).not.toContain(MEMORY_BODY)

  const second = llm.calls[1]!.messages
  expect(messageText(second)).toContain(MEMORY_BODY)
  const last = second[second.length - 1]
  expect(last?.type).toBe("user")
  expect(last?.type === "user" ? last.content.map((part) => part.text).join("") : "").toContain(MEMORY_BODY)

  const recall = events.find((event) => event.type === "memory-recall")
  expect(recall).toEqual({ type: "memory-recall", names: ["push_habits"] })
})

test("recall settling after the turn is carried into the next turn", async () => {
  const gate = gatedSelector()
  const config = testConfig()
  const memory = createMemorySession({ config, dir, complete: gate.complete })
  const session = createSession("/tmp/zcode-test")
  const runtime = testRuntime(config, [])
  const llm = mockLLM([{ text: "first" }, { text: "second" }])
  const signal = new AbortController().signal

  await collect(
    query({ prompt: "how should I ship this", session, config, runtime, signal, deps: { llm: llm.fn, memory } }),
  )

  // The turn never waited on the selector.
  expect(llm.calls).toHaveLength(1)
  expect(messageText(llm.calls[0]!.messages)).not.toContain(MEMORY_BODY)

  gate.release()
  await drainBackground()

  const events = await collect(query({ prompt: "ok", session, config, runtime, signal, deps: { llm: llm.fn, memory } }))

  expect(llm.calls).toHaveLength(2)
  expect(messageText(llm.calls[1]!.messages)).toContain(MEMORY_BODY)
  expect(events.some((event) => event.type === "memory-recall")).toBe(true)
})

test("a new turn retains an unsettled prefetch instead of starting another", async () => {
  const gate = gatedSelector()
  const memory = createMemorySession({ config: testConfig(), dir, complete: gate.complete })
  const signal = new AbortController().signal

  memory.beginTurn("first substantial prompt", signal)
  await drainBackground()
  memory.beginTurn("second substantial prompt", signal)
  await drainBackground()

  expect(gate.calls).toHaveLength(1)
  gate.release()
  await drainBackground()
  expect(memory.pollInjection()?.names).toEqual(["push_habits"])
})

test("recall content cannot exceed the remaining session memory budget", async () => {
  const gate = gatedSelector()
  gate.release()
  const config = testConfig({ memory: { enabled: true, sessionBudgetBytes: 10 } })
  const memory = createMemorySession({ config, dir, complete: gate.complete })

  memory.beginTurn("substantial memory prompt", new AbortController().signal)
  await drainBackground()
  const recall = memory.pollInjection()

  expect(recall?.text).toContain(MEMORY_BODY.slice(0, 10))
  expect(recall?.text).not.toContain(MEMORY_BODY)
  memory.beginTurn("another substantial prompt", new AbortController().signal)
  expect(gate.calls).toHaveLength(1)
})

test("a memory whose first character cannot fit is not selected repeatedly", async () => {
  await rm(path.join(dir, "user_push_habits.md"))
  await saveMemory(dir, {
    name: "cjk",
    description: "starts with a multibyte character",
    type: "user",
    content: "你 should not be retried",
  })
  const calls: CompleteRequest[] = []
  const complete: CompleteFn = async (request) => {
    calls.push(request)
    return JSON.stringify({ selected_memories: ["user_cjk.md"] })
  }
  const config = testConfig({ memory: { enabled: true, sessionBudgetBytes: 1 } })
  const memory = createMemorySession({ config, dir, complete })

  memory.beginTurn("first substantial prompt", new AbortController().signal)
  await drainBackground()
  expect(memory.pollInjection()).toBeNull()
  memory.beginTurn("second substantial prompt", new AbortController().signal)
  await drainBackground()

  expect(calls).toHaveLength(1)
})

test("turn boundaries do not mutate session history", async () => {
  const gate = gatedSelector()
  gate.release()
  const config = testConfig()
  const memory = createMemorySession({ config, dir, complete: gate.complete })
  const session = createSession("/tmp/zcode-test")
  const runtime = testRuntime(config, [waitTool(async () => drainBackground())])
  const llm = mockLLM([
    { text: "one", toolCalls: [{ callId: "c1", name: "echo", input: { text: "hi" } }] },
    { text: "two" },
  ])

  await collect(
    query({
      prompt: "remind me how I ship",
      session,
      config,
      runtime,
      signal: new AbortController().signal,
      deps: { llm: llm.fn, memory },
    }),
  )

  expect(messageText(llm.calls[1]!.messages)).toContain(MEMORY_BODY)
  // The pristine history the JSONL store and the Ink transcript both read carries none of it.
  expect(messageText(session.items)).not.toContain(MEMORY_BODY)
  expect(messageText(session.items)).not.toContain("<system-reminder>")
  expect(session.items.every((item) => item.type !== "user" || !messageText([item]).includes("Memory:"))).toBe(true)
})

test("insubstantial prompts never call the side model", async () => {
  const gate = gatedSelector()
  gate.release()
  const config = testConfig()
  const memory = createMemorySession({ config, dir, complete: gate.complete })
  const session = createSession("/tmp/zcode-test")
  const runtime = testRuntime(config, [])
  const llm = mockLLM([{ text: "hi" }])

  await collect(
    query({
      prompt: "ok",
      session,
      config,
      runtime,
      signal: new AbortController().signal,
      deps: { llm: llm.fn, memory },
    }),
  )
  await drainBackground(5)

  expect(gate.calls).toHaveLength(0)
  expect(messageText(llm.calls[0]!.messages)).not.toContain(MEMORY_BODY)
})

test("subagent-style invocation runs no recall", async () => {
  const gate = gatedSelector()
  gate.release()
  const config = testConfig()
  // A child is simply never given `deps.memory` — see src/subagents/runner.ts.
  const session = createSession("/tmp/zcode-test")
  const runtime = testRuntime(config, [])
  const llm = mockLLM([{ text: "child report" }])

  await collect(
    query({
      prompt: "search the codebase for the retry helper",
      session,
      config,
      runtime,
      signal: new AbortController().signal,
      deps: { llm: llm.fn },
    }),
  )
  await drainBackground(5)

  expect(gate.calls).toHaveLength(0)
  expect(messageText(llm.calls[0]!.messages)).not.toContain(MEMORY_BODY)
  expect(llm.calls[0]!.messages.some((item) => item.type === "user")).toBe(true)
})
