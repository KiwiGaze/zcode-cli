import { test, expect } from "bun:test"
import { z } from "zod"
import { query } from "@/agent/query"
import { evaluateBudget, estimateCost, estimateSessionCost } from "@/agent/budget"
import { createSession, recordUsage } from "@/session/session"
import type { Session } from "@/session/session"
import { defineTool, type AnyTool } from "@/tools/registry"
import { okResult } from "@/tools/types"
import type { AgentEvent } from "@/agent/events"
import type { ChatItem } from "@/session/messages"
import type { MemorySession } from "@/memory/recall"
import { mockLLM, type MockTurn } from "../support/mock-llm"
import { testConfig, withApiKey } from "../support/config"
import { testRuntime } from "../support/runtime"

async function collect(gen: AsyncGenerator<AgentEvent, void>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of gen) events.push(event)
  return events
}

function echoTool(calls: string[]): AnyTool {
  return defineTool<{ text: string }>({
    name: "echo",
    description: "echo text back",
    inputSchema: z.object({ text: z.string() }),
    permission: () => null,
    execute: async (input) => {
      calls.push(input.text)
      return okResult(`echoed: ${input.text}`)
    },
  })
}

function toolTurn(index: number, count = 1): MockTurn {
  return {
    toolCalls: Array.from({ length: count }, (_, slot) => ({
      callId: `t${index}-${slot}`,
      name: "echo",
      input: { text: `${index}-${slot}` },
    })),
  }
}

/** Every assistant tool-call part is answered by a later tool-result with the same callId. */
function unpairedCalls(items: ChatItem[]): string[] {
  const answered = new Set<string>()
  for (const item of items) if (item.type === "tool-result") answered.add(item.callId)
  const dangling: string[] = []
  for (const item of items) {
    if (item.type !== "assistant") continue
    for (const part of item.parts) {
      if (part.type === "tool-call" && !answered.has(part.callId)) dangling.push(part.callId)
    }
  }
  return dangling
}

function reasons(events: AgentEvent[], type: "budget-warning" | "budget-exceeded"): string[] {
  return events
    .filter(
      (event): event is Extract<AgentEvent, { type: "budget-warning" | "budget-exceeded" }> => event.type === type,
    )
    .map((event) => event.reason)
}

test("stops at the turn limit and refuses every pending tool call", async () => {
  const restore = withApiKey()
  try {
    const config = testConfig({ budget: { maxTurns: 1, warnAt: 0.8 } })
    const session = createSession("/tmp/zcode-test")
    const calls: string[] = []
    const runtime = testRuntime(config, [echoTool(calls)])
    const llm = mockLLM([toolTurn(1, 2), { text: "done" }])

    const events = await collect(
      query({ prompt: "go", session, config, runtime, signal: new AbortController().signal, deps: { llm: llm.fn } }),
    )

    expect(calls).toEqual([])
    expect(llm.calls).toHaveLength(1)
    expect(events.some((event) => event.type === "tool-start")).toBe(false)

    const exceeded = reasons(events, "budget-exceeded")
    expect(exceeded).toHaveLength(1)
    expect(exceeded[0]).toContain("turn limit reached (1/1 turns)")

    const results = session.items.filter((item) => item.type === "tool-result")
    expect(results.map((item) => item.callId).sort()).toEqual(["t1-0", "t1-1"])
    for (const result of results) {
      expect(result.result.status).toBe("denied")
      expect(result.result.output).toContain("not executed")
    }
    expect(unpairedCalls(session.items)).toEqual([])
  } finally {
    restore()
  }
})

test("history stays continuable after a budget stop", async () => {
  const restore = withApiKey()
  try {
    const config = testConfig({ budget: { maxTurns: 1, warnAt: 0.8 } })
    const session: Session = createSession("/tmp/zcode-test")
    const runtime = testRuntime(config, [echoTool([])])
    const signal = new AbortController().signal

    const stopper = mockLLM([toolTurn(1, 2)])
    await collect(query({ prompt: "go", session, config, runtime, signal, deps: { llm: stopper.fn } }))
    expect(unpairedCalls(session.items)).toEqual([])

    const resumed = mockLLM([{ text: "carrying on" }])
    const events = await collect(
      query({ prompt: "continue", session, config, runtime, signal, deps: { llm: resumed.fn } }),
    )

    expect(events.some((event) => event.type === "done")).toBe(true)
    // The request the provider actually saw carries the pairing, not just our history.
    expect(unpairedCalls(resumed.calls[0]!.messages)).toEqual([])
    expect(unpairedCalls(session.items)).toEqual([])
  } finally {
    restore()
  }
})

test("executes the batch that started before the limit", async () => {
  const restore = withApiKey()
  try {
    const config = testConfig({ budget: { maxTurns: 2, warnAt: 0.8 } })
    const session = createSession("/tmp/zcode-test")
    const calls: string[] = []
    const runtime = testRuntime(config, [echoTool(calls)])
    const llm = mockLLM([toolTurn(1), toolTurn(2), toolTurn(3)])

    const events = await collect(
      query({ prompt: "go", session, config, runtime, signal: new AbortController().signal, deps: { llm: llm.fn } }),
    )

    expect(calls).toEqual(["1-0"])
    expect(llm.calls).toHaveLength(2)
    expect(reasons(events, "budget-exceeded")).toHaveLength(1)

    const refused = session.items.find((item) => item.type === "tool-result" && item.callId === "t2-0")
    expect(refused?.type === "tool-result" ? refused.result.status : "").toBe("denied")
    expect(unpairedCalls(session.items)).toEqual([])
  } finally {
    restore()
  }
})

test("stops at the cost limit using configured pricing", async () => {
  const restore = withApiKey()
  try {
    const config = testConfig({ budget: { maxCostUsd: 1, warnAt: 0.8 } })
    const session = createSession("/tmp/zcode-test")
    const calls: string[] = []
    const runtime = testRuntime(config, [echoTool(calls)])
    // glm-5.2 input is $1.4/Mtok, so one million prompt tokens costs $1.40 — over the $1 cap.
    const llm = mockLLM([{ ...toolTurn(1), usage: { input: 1_000_000, output: 0 } }, { text: "done" }])

    const events = await collect(
      query({ prompt: "go", session, config, runtime, signal: new AbortController().signal, deps: { llm: llm.fn } }),
    )

    expect(estimateCost(config, config.model, session.totalUsage)).toBeCloseTo(1.4, 5)
    expect(calls).toEqual([])
    const exceeded = reasons(events, "budget-exceeded")
    expect(exceeded).toHaveLength(1)
    expect(exceeded[0]).toContain("cost limit reached")
    expect(exceeded[0]).toContain("$1.00 budget")
    expect(unpairedCalls(session.items)).toEqual([])
  } finally {
    restore()
  }
})

test("does not start a model request after the session cost cap is spent", async () => {
  const restore = withApiKey()
  try {
    const config = testConfig({ budget: { maxCostUsd: 1, warnAt: 0.8 } })
    const session = createSession("/tmp/zcode-test")
    recordUsage(session, config.model, { input: 1_000_000, output: 0, reasoning: 0, cachedInput: 0 })
    const runtime = testRuntime(config)
    const llm = mockLLM([{ text: "must not run" }])
    let memoryStarts = 0
    const memory: MemorySession = {
      beginTurn: () => {
        memoryStarts += 1
      },
      pollInjection: () => null,
      promptSection: async () => "",
      setConfig: () => {},
      reset: () => {},
    }

    const events = await collect(
      query({
        prompt: "continue",
        session,
        config,
        runtime,
        signal: new AbortController().signal,
        deps: { llm: llm.fn, memory },
      }),
    )

    expect(llm.calls).toHaveLength(0)
    expect(memoryStarts).toBe(0)
    expect(reasons(events, "budget-exceeded")).toHaveLength(1)
  } finally {
    restore()
  }
})

test("warns once when approaching the turn limit and keeps going", async () => {
  const restore = withApiKey()
  try {
    // A wide band matters: with maxTurns 10 the threshold is crossed on turns 8 and 9 before
    // turn 10 exceeds, so a dedup keyed on the (changing) message text would warn twice.
    const config = testConfig({ budget: { maxTurns: 10, warnAt: 0.8 } })
    const session = createSession("/tmp/zcode-test")
    const calls: string[] = []
    const runtime = testRuntime(config, [echoTool(calls)])
    const llm = mockLLM(Array.from({ length: 11 }, (_, index) => toolTurn(index + 1)))

    const events = await collect(
      query({ prompt: "go", session, config, runtime, signal: new AbortController().signal, deps: { llm: llm.fn } }),
    )

    expect(calls).toEqual(["1-0", "2-0", "3-0", "4-0", "5-0", "6-0", "7-0", "8-0", "9-0"])
    const warnings = reasons(events, "budget-warning")
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("turn budget: 8 of 10 turns used")

    const warnAt = events.findIndex((event) => event.type === "budget-warning")
    const stopAt = events.findIndex((event) => event.type === "budget-exceeded")
    expect(warnAt).toBeGreaterThanOrEqual(0)
    expect(stopAt).toBeGreaterThan(warnAt)
    expect(unpairedCalls(session.items)).toEqual([])
  } finally {
    restore()
  }
})

test("discloses when the model has no pricing and enforces turns only", async () => {
  const restore = withApiKey()
  try {
    const config = testConfig({
      models: { "glm-5.2": { context: 200_000, maxOutput: 128_000 } },
      budget: { maxCostUsd: 0.000_001, maxTurns: 2, warnAt: 0.8 },
    })
    const session = createSession("/tmp/zcode-test")
    const calls: string[] = []
    const runtime = testRuntime(config, [echoTool(calls)])
    const llm = mockLLM([toolTurn(1), toolTurn(2), toolTurn(3)])

    const events = await collect(
      query({ prompt: "go", session, config, runtime, signal: new AbortController().signal, deps: { llm: llm.fn } }),
    )

    const warnings = reasons(events, "budget-warning")
    expect(warnings[0]).toContain('cost unknown for model "glm-5.2"')
    expect(warnings[0]).toContain("not enforced")

    // A cost cap far below one turn's spend never fires; the run stops on turns instead.
    const exceeded = reasons(events, "budget-exceeded")
    expect(exceeded).toHaveLength(1)
    expect(exceeded[0]).toContain("turn limit reached")
    expect(exceeded.some((reason) => reason.includes("cost limit"))).toBe(false)
    expect(calls).toEqual(["1-0"])
  } finally {
    restore()
  }
})

test("evaluateBudget prefers exceeded over warn and leaves absent limits unlimited", () => {
  const unlimited = { warnAt: 0.8 }
  expect(evaluateBudget(unlimited, { turns: 10_000, costUsd: 9_999 })).toEqual({ kind: "ok" })

  const both = { maxTurns: 5, maxCostUsd: 1, warnAt: 0.8 }
  expect(evaluateBudget(both, { turns: 5, costUsd: 0.9 }).kind).toBe("exceeded")
  expect(evaluateBudget(both, { turns: 1, costUsd: 0.1 }).kind).toBe("ok")

  // A warning names the limit it came from, which is what callers dedupe on — the message text
  // carries the running total and therefore differs on every turn.
  expect(evaluateBudget(both, { turns: 4, costUsd: 0.9 })).toMatchObject({ kind: "warn", limit: "cost" })
  expect(evaluateBudget({ maxTurns: 5, warnAt: 0.8 }, { turns: 4, costUsd: 0 })).toMatchObject({
    kind: "warn",
    limit: "turns",
  })

  // Cost is checked before turns, so a cost stop names the cost.
  const costFirst = evaluateBudget(both, { turns: 5, costUsd: 2 })
  expect(costFirst.kind === "exceeded" ? costFirst.reason : "").toContain("cost limit")

  // warnAt: 1 collapses the warning onto the exceeded check, which wins.
  expect(evaluateBudget({ maxTurns: 3, warnAt: 1 }, { turns: 2, costUsd: 0 })).toEqual({ kind: "ok" })
  expect(evaluateBudget({ maxTurns: 3, warnAt: 1 }, { turns: 3, costUsd: 0 }).kind).toBe("exceeded")
})

test("prices model-attributed usage with each model's own rates", () => {
  const config = testConfig({
    models: {
      main: { context: 100_000, maxOutput: 10_000, pricing: { input: 1, cachedInput: 0.5, output: 2 } },
      gate: { context: 100_000, maxOutput: 10_000, pricing: { input: 4, cachedInput: 1, output: 8 } },
    },
  })

  expect(
    estimateSessionCost(config, {
      main: { input: 1_000_000, output: 0, reasoning: 0, cachedInput: 0 },
      gate: { input: 1_000_000, output: 0, reasoning: 0, cachedInput: 0 },
    }),
  ).toBe(5)
})
