import { test, expect } from "bun:test"
import { z } from "zod"
import { query } from "@/agent/query"
import { createSession } from "@/session/session"
import { defineTool, type AnyTool } from "@/tools/registry"
import { okResult } from "@/tools/types"
import type { AgentEvent } from "@/agent/events"
import type { LLMStreamFn } from "@/llm/types"
import type { TokenUsage } from "@/session/messages"
import { testConfig, withApiKey } from "../support/config"
import { testRuntime } from "../support/runtime"

const USAGE: TokenUsage = { input: 10, output: 5, reasoning: 0, cachedInput: 0 }

async function collect(gen: AsyncGenerator<AgentEvent, void>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of gen) events.push(event)
  return events
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

interface StreamScript {
  toolCalls?: { callId: string; name: string; input: unknown }[]
  /** Runs after every tool call has been consumed by the loop, but before `finish` is emitted. */
  beforeFinish?: () => Promise<unknown> | void
  text?: string
}

/**
 * A stream the test drives directly. `beforeFinish` is the load-bearing part: it observes the world
 * at a moment that only exists if tools started mid-stream, since a tool that runs after `finish`
 * can never satisfy a gate resolved from inside `execute`.
 */
function scriptedLLM(script: StreamScript[]): { fn: LLMStreamFn; calls: number } {
  const state = { calls: 0 }
  const fn: LLMStreamFn = async function* () {
    const turn = script[state.calls] ?? {}
    state.calls += 1
    if (turn.text !== undefined) yield { type: "text-delta", text: turn.text }
    for (const call of turn.toolCalls ?? []) {
      yield { type: "tool-call", callId: call.callId, name: call.name, input: call.input }
    }
    if (turn.beforeFinish !== undefined) await turn.beforeFinish()
    yield {
      type: "finish",
      reason: (turn.toolCalls ?? []).length > 0 ? "tool-calls" : "stop",
      usage: { ...USAGE },
    }
  }
  return {
    fn,
    get calls() {
      return state.calls
    },
  }
}

interface Probe {
  tool: AnyTool
  started: string[]
  finished: string[]
}

function safeTool(name: string, onEnter?: (id: string) => Promise<void> | void): Probe {
  const started: string[] = []
  const finished: string[] = []
  const tool = defineTool<{ id: string }>({
    name,
    description: "a concurrency-safe read-only probe",
    inputSchema: z.object({ id: z.string() }),
    concurrencySafe: true,
    permission: () => null,
    execute: async (input) => {
      started.push(input.id)
      await onEnter?.(input.id)
      finished.push(input.id)
      return okResult(`ran ${input.id}`)
    },
  })
  return { tool, started, finished }
}

/** Concurrency-safe but permission-gated, so policy alone decides eligibility. */
function gatedTool(name: string): Probe {
  const started: string[] = []
  const finished: string[] = []
  const tool = defineTool<{ id: string }>({
    name,
    description: "a concurrency-safe tool that still asks",
    inputSchema: z.object({ id: z.string() }),
    concurrencySafe: true,
    permission: (input, ctx) => ({
      tool: name,
      callId: ctx.callId,
      title: `${name}: ${input.id}`,
      key: `${name}:${input.id}`,
      subject: input.id,
    }),
    execute: async (input) => {
      started.push(input.id)
      finished.push(input.id)
      return okResult(`ran ${input.id}`)
    },
  })
  return { tool, started, finished }
}

test("starts an eligible tool before the stream finishes", async () => {
  const restore = withApiKey()
  try {
    const entered = deferred()
    const probe = safeTool("probe", () => {
      entered.resolve()
    })
    const config = testConfig()
    const session = createSession("/tmp/zcode-test")
    const runtime = testRuntime(config, [probe.tool])
    // The stream will not emit `finish` until the tool has begun executing. If early execution
    // regresses, nothing ever resolves the gate and this test fails by timeout.
    const llm = scriptedLLM([
      { toolCalls: [{ callId: "c1", name: "probe", input: { id: "a" } }], beforeFinish: () => entered.promise },
      { text: "done" },
    ])

    const events = await collect(
      query({ prompt: "go", session, config, runtime, signal: new AbortController().signal, deps: { llm: llm.fn } }),
    )

    expect(probe.started).toEqual(["a"])
    const toolEnd = events.find(
      (event): event is Extract<AgentEvent, { type: "tool-end" }> => event.type === "tool-end",
    )
    expect(toolEnd?.result.status).toBe("ok")
    expect(events.filter((event) => event.type === "tool-start")).toHaveLength(1)
  } finally {
    restore()
  }
})

test("respects the config opt-out", async () => {
  const restore = withApiKey()
  try {
    const order: string[] = []
    const probe = safeTool("probe", () => {
      order.push("execute")
    })
    const config = testConfig({ earlyToolExecution: false })
    const session = createSession("/tmp/zcode-test")
    const runtime = testRuntime(config, [probe.tool])
    let turn = 0
    const llm: LLMStreamFn = async function* () {
      turn += 1
      if (turn > 1) {
        yield { type: "finish", reason: "stop", usage: { ...USAGE } }
        return
      }
      yield { type: "tool-call", callId: "c1", name: "probe", input: { id: "a" } }
      order.push("finish")
      yield { type: "finish", reason: "tool-calls", usage: { ...USAGE } }
    }

    await collect(
      query({ prompt: "go", session, config, runtime, signal: new AbortController().signal, deps: { llm } }),
    )

    // With the opt-out, execution strictly follows the end of the stream.
    expect(order).toEqual(["finish", "execute"])
  } finally {
    restore()
  }
})

test("defers tools that need approval and keeps dialogs sequential", async () => {
  const restore = withApiKey()
  try {
    const entered = deferred()
    const safe = safeTool("probe", () => {
      entered.resolve()
    })
    const gated = gatedTool("danger")
    const config = testConfig({ permissions: { danger: "ask" } })
    const session = createSession("/tmp/zcode-test")
    const runtime = testRuntime(config, [safe.tool, gated.tool])
    const llm = scriptedLLM([
      {
        toolCalls: [
          { callId: "c1", name: "probe", input: { id: "a" } },
          { callId: "c2", name: "danger", input: { id: "b" } },
        ],
        beforeFinish: () => entered.promise,
      },
      { text: "done" },
    ])

    const events: AgentEvent[] = []
    let askedWhileGatedIdle = false
    for await (const event of query({
      prompt: "go",
      session,
      config,
      runtime,
      signal: new AbortController().signal,
      deps: { llm: llm.fn },
    })) {
      if (event.type === "permission-ask") {
        // The gated tool must not have run before its dialog was answered.
        askedWhileGatedIdle = gated.started.length === 0
        event.respond("allow-once")
      }
      events.push(event)
    }

    expect(events.filter((event) => event.type === "permission-ask")).toHaveLength(1)
    expect(askedWhileGatedIdle).toBe(true)
    expect(safe.started).toEqual(["a"])
    expect(gated.started).toEqual(["b"])
    expect(session.items.filter((item) => item.type === "tool-result")).toHaveLength(2)
  } finally {
    restore()
  }
})

test("never starts a denied or policy-blocked tool early", async () => {
  const restore = withApiKey()
  try {
    const gated = gatedTool("danger")
    const config = testConfig({ permissions: { danger: "deny" } })
    const session = createSession("/tmp/zcode-test")
    const runtime = testRuntime(config, [gated.tool])
    const llm = scriptedLLM([
      { toolCalls: [{ callId: "c1", name: "danger", input: { id: "a" } }] },
      { text: "understood" },
    ])

    const events = await collect(
      query({ prompt: "go", session, config, runtime, signal: new AbortController().signal, deps: { llm: llm.fn } }),
    )

    expect(gated.started).toEqual([])
    const toolEnd = events.find(
      (event): event is Extract<AgentEvent, { type: "tool-end" }> => event.type === "tool-end",
    )
    expect(toolEnd?.result.status).toBe("denied")
  } finally {
    restore()
  }
})

test("never starts a tool that is not marked concurrency-safe", async () => {
  const restore = withApiKey()
  try {
    const order: string[] = []
    const unsafe = defineTool<{ id: string }>({
      name: "mutate",
      description: "not concurrency-safe",
      inputSchema: z.object({ id: z.string() }),
      permission: () => null,
      execute: async (input) => {
        order.push(`execute:${input.id}`)
        return okResult("mutated")
      },
    })
    const config = testConfig()
    const session = createSession("/tmp/zcode-test")
    const runtime = testRuntime(config, [unsafe])
    let turn = 0
    const llm: LLMStreamFn = async function* () {
      turn += 1
      if (turn > 1) {
        yield { type: "finish", reason: "stop", usage: { ...USAGE } }
        return
      }
      yield { type: "tool-call", callId: "c1", name: "mutate", input: { id: "a" } }
      order.push("finish")
      yield { type: "finish", reason: "tool-calls", usage: { ...USAGE } }
    }

    await collect(
      query({ prompt: "go", session, config, runtime, signal: new AbortController().signal, deps: { llm } }),
    )

    expect(order).toEqual(["finish", "execute:a"])
  } finally {
    restore()
  }
})

test("appends results in tool-call order regardless of completion order", async () => {
  const restore = withApiKey()
  try {
    const slow = deferred()
    const probe = safeTool("probe", async (id) => {
      if (id === "first") await slow.promise
    })
    const config = testConfig()
    const session = createSession("/tmp/zcode-test")
    const runtime = testRuntime(config, [probe.tool])
    const llm = scriptedLLM([
      {
        toolCalls: [
          { callId: "c1", name: "probe", input: { id: "first" } },
          { callId: "c2", name: "probe", input: { id: "second" } },
        ],
      },
      { text: "done" },
    ])

    // Release the first call only after the second has already finished.
    const run = collect(
      query({ prompt: "go", session, config, runtime, signal: new AbortController().signal, deps: { llm: llm.fn } }),
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(probe.finished).toEqual(["second"])
    slow.resolve()
    const events = await run

    expect(probe.finished).toEqual(["second", "first"])
    const results = session.items.filter((item) => item.type === "tool-result")
    expect(results.map((item) => item.callId)).toEqual(["c1", "c2"])
    const ends = events.filter((event) => event.type === "tool-end").map((event) => event.callId)
    expect(ends).toEqual(["c1", "c2"])
  } finally {
    restore()
  }
})

test("executes each early call exactly once", async () => {
  const restore = withApiKey()
  try {
    const safe = safeTool("probe")
    const gated = gatedTool("danger")
    const config = testConfig({ permissions: { danger: "ask" } })
    const session = createSession("/tmp/zcode-test")
    const runtime = testRuntime(config, [safe.tool, gated.tool])
    const llm = scriptedLLM([
      {
        toolCalls: [
          { callId: "c1", name: "probe", input: { id: "a" } },
          { callId: "c2", name: "danger", input: { id: "b" } },
          { callId: "c3", name: "probe", input: { id: "c" } },
        ],
      },
      { text: "done" },
    ])

    const events: AgentEvent[] = []
    for await (const event of query({
      prompt: "go",
      session,
      config,
      runtime,
      signal: new AbortController().signal,
      deps: { llm: llm.fn },
    })) {
      if (event.type === "permission-ask") event.respond("allow-once")
      events.push(event)
    }

    expect(safe.started).toEqual(["a", "c"])
    expect(gated.started).toEqual(["b"])
    // One tool-start per call, never a duplicate for an early one.
    const starts = events.filter((event) => event.type === "tool-start").map((event) => event.callId)
    expect(starts.sort()).toEqual(["c1", "c2", "c3"])
    expect(session.items.filter((item) => item.type === "tool-result")).toHaveLength(3)
  } finally {
    restore()
  }
})

test("caps early starts at the tool concurrency limit", async () => {
  const restore = withApiKey()
  try {
    const gate = deferred()
    const probe = safeTool("probe", () => gate.promise)
    const config = testConfig()
    const session = createSession("/tmp/zcode-test")
    const runtime = testRuntime(config, [probe.tool])
    const ids = ["a", "b", "c", "d", "e", "f"]
    let startedDuringStream = -1
    const llm = scriptedLLM([
      {
        toolCalls: ids.map((id, index) => ({ callId: `c${index}`, name: "probe", input: { id } })),
        // Sampled with all six calls consumed but the stream still open.
        beforeFinish: () => {
          startedDuringStream = probe.started.length
        },
      },
      { text: "done" },
    ])

    const run = collect(
      query({ prompt: "go", session, config, runtime, signal: new AbortController().signal, deps: { llm: llm.fn } }),
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    // MAX_TOOL_CONCURRENCY is 4: early execution may never park more than that.
    expect(startedDuringStream).toBe(4)
    gate.resolve()
    await run

    expect(probe.finished.sort()).toEqual([...ids].sort())
    expect(session.items.filter((item) => item.type === "tool-result")).toHaveLength(6)
  } finally {
    restore()
  }
})

test("aborts in-flight early executions on interrupt", async () => {
  const restore = withApiKey()
  try {
    const controller = new AbortController()
    const running = deferred()
    const probe = safeTool("probe", (id) => {
      running.resolve()
      // Park until the turn is interrupted, then report the interruption like any tool would.
      return new Promise<void>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error(`aborted ${id}`)), { once: true })
      })
    })
    const config = testConfig()
    const session = createSession("/tmp/zcode-test")
    const runtime = testRuntime(config, [probe.tool])
    const llm = scriptedLLM([
      { toolCalls: [{ callId: "c1", name: "probe", input: { id: "a" } }], beforeFinish: () => running.promise },
      { text: "unreachable" },
    ])

    const run = collect(
      query({ prompt: "go", session, config, runtime, signal: controller.signal, deps: { llm: llm.fn } }),
    )
    await running.promise
    controller.abort()
    const events = await run

    // The started call is paired rather than abandoned, so history stays valid.
    const result = session.items.find((item) => item.type === "tool-result" && item.callId === "c1")
    expect(result).toBeDefined()
    expect(events.some((event) => event.type === "tool-end" && event.callId === "c1")).toBe(true)
  } finally {
    restore()
  }
})

test("drains in-flight early executions at the budget gate and refuses only unstarted calls", async () => {
  const restore = withApiKey()
  try {
    const entered = deferred()
    const safe = safeTool("probe", () => {
      entered.resolve()
    })
    const gated = gatedTool("danger")
    // glm-5.2 input is $1.4/Mtok; one turn of a million prompt tokens blows a $1 cap.
    const config = testConfig({ permissions: { danger: "ask" }, budget: { maxCostUsd: 1, warnAt: 0.8 } })
    const session = createSession("/tmp/zcode-test")
    const runtime = testRuntime(config, [safe.tool, gated.tool])
    const llm: LLMStreamFn = async function* () {
      yield { type: "tool-call", callId: "c1", name: "probe", input: { id: "a" } }
      yield { type: "tool-call", callId: "c2", name: "danger", input: { id: "b" } }
      await entered.promise
      yield {
        type: "finish",
        reason: "tool-calls",
        usage: { input: 1_000_000, output: 0, reasoning: 0, cachedInput: 0 },
      }
    }

    const events = await collect(
      query({ prompt: "go", session, config, runtime, signal: new AbortController().signal, deps: { llm } }),
    )

    expect(events.some((event) => event.type === "budget-exceeded")).toBe(true)
    expect(events.some((event) => event.type === "permission-ask")).toBe(false)
    expect(gated.started).toEqual([])

    const results = session.items.filter((item) => item.type === "tool-result")
    expect(results.map((item) => item.callId)).toEqual(["c1", "c2"])
    // The started call keeps its real result; only the unstarted one is refused.
    expect(results[0]?.type === "tool-result" ? results[0].result.status : "").toBe("ok")
    expect(results[0]?.type === "tool-result" ? results[0].result.output : "").toContain("ran a")
    expect(results[1]?.type === "tool-result" ? results[1].result.status : "").toBe("denied")
    expect(results[1]?.type === "tool-result" ? results[1].result.output : "").toContain("not executed")
  } finally {
    restore()
  }
})

test("a projected turn-limit stop keeps every call out of early execution", async () => {
  const restore = withApiKey()
  try {
    const safe = safeTool("probe")
    const config = testConfig({ budget: { maxTurns: 1, warnAt: 0.8 } })
    const session = createSession("/tmp/zcode-test")
    const runtime = testRuntime(config, [safe.tool])
    const llm = scriptedLLM([{ toolCalls: [{ callId: "c1", name: "probe", input: { id: "a" } }] }, { text: "done" }])

    const events = await collect(
      query({ prompt: "go", session, config, runtime, signal: new AbortController().signal, deps: { llm: llm.fn } }),
    )

    // The gate would refuse this turn, so nothing starts speculatively.
    expect(safe.started).toEqual([])
    expect(events.some((event) => event.type === "budget-exceeded")).toBe(true)
    const results = session.items.filter((item) => item.type === "tool-result")
    expect(results[0]?.type === "tool-result" ? results[0].result.status : "").toBe("denied")
  } finally {
    restore()
  }
})
