import { test, expect } from "bun:test"
import { z } from "zod"
import { query } from "@/agent/query"
import { createSession } from "@/session/session"
import { createToolSearchTool } from "@/tools/tool-search"
import { TOOL_SEARCH_NAME } from "@/tools/deferred"
import { defineTool, type AnyTool } from "@/tools/registry"
import { okResult } from "@/tools/types"
import type { AgentEvent } from "@/agent/events"
import type { AgentRuntime } from "@/agent/runtime"
import type { ResolvedConfig } from "@/config/config"
import { mockLLM } from "../support/mock-llm"
import { testConfig, withApiKey } from "../support/config"
import { testRuntime } from "../support/runtime"

async function collect(gen: AsyncGenerator<AgentEvent, void>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of gen) events.push(event)
  return events
}

function probeTool(runs: string[]): AnyTool {
  return {
    ...defineTool<{ target: string }>({
      name: "mcp__srv__probe",
      description: "Check whether a remote host is reachable",
      inputSchema: z.object({ target: z.string().describe("host to probe") }),
      permission: () => null,
      execute: async (input) => {
        runs.push(input.target)
        return okResult(`probed ${input.target}`)
      },
    }),
    mcpServer: "srv",
  }
}

function setup(runs: string[]): { config: ResolvedConfig; runtime: AgentRuntime } {
  const config = testConfig({
    mcp: { servers: { srv: { type: "stdio", command: "bun", args: [], env: {}, defer: true } } },
  })
  const runtime = testRuntime(config, [probeTool(runs)])
  runtime.registry.register(createToolSearchTool(runtime))
  return { config, runtime }
}

function toolNames(tools: { name: string }[]): string[] {
  return tools.map((tool) => tool.name)
}

test("deferred schemas are absent from requests until toolsearch activates them", async () => {
  const restore = withApiKey()
  try {
    const runs: string[] = []
    const { config, runtime } = setup(runs)
    const session = createSession("/tmp/zcode-test")
    const llm = mockLLM([
      { toolCalls: [{ callId: "s1", name: TOOL_SEARCH_NAME, input: { query: "reachable" } }] },
      { toolCalls: [{ callId: "p1", name: "mcp__srv__probe", input: { target: "example.com" } }] },
      { text: "done" },
    ])

    await collect(
      query({
        prompt: "probe it",
        session,
        config,
        runtime,
        signal: new AbortController().signal,
        deps: { llm: llm.fn },
      }),
    )

    expect(llm.calls).toHaveLength(3)
    // Turn 1: the schema is nowhere in the request, only the name inside toolsearch's description.
    expect(toolNames(llm.calls[0]!.tools)).not.toContain("mcp__srv__probe")
    expect(toolNames(llm.calls[0]!.tools)).toContain(TOOL_SEARCH_NAME)
    expect(JSON.stringify(llm.calls[0]!.tools)).not.toContain("host to probe")

    // Turn 2: activation took effect on the very next request, schema included.
    const activated = llm.calls[1]!.tools.find((tool) => tool.name === "mcp__srv__probe")
    expect(activated).toBeDefined()
    expect(JSON.stringify(activated?.inputSchema)).toContain("host to probe")

    expect(runs).toEqual(["example.com"])
    const results = session.items.filter((item) => item.type === "tool-result")
    expect(results.map((item) => item.callId)).toEqual(["s1", "p1"])
    expect(results[1]?.type === "tool-result" ? results[1].result.status : "").toBe("ok")
  } finally {
    restore()
  }
})

test("a direct call to a non-activated deferred tool fails closed", async () => {
  const restore = withApiKey()
  try {
    const runs: string[] = []
    const { config, runtime } = setup(runs)
    const session = createSession("/tmp/zcode-test")
    const llm = mockLLM([
      { toolCalls: [{ callId: "p1", name: "mcp__srv__probe", input: { target: "example.com" } }] },
      { text: "understood" },
    ])

    const events = await collect(
      query({
        prompt: "probe it",
        session,
        config,
        runtime,
        signal: new AbortController().signal,
        deps: { llm: llm.fn },
      }),
    )

    expect(runs).toEqual([])
    const toolEnd = events.find(
      (event): event is Extract<AgentEvent, { type: "tool-end" }> => event.type === "tool-end",
    )
    expect(toolEnd?.result.status).toBe("error")
    expect(toolEnd?.result.output).toContain("toolsearch")
    // The refusal did not activate anything: the next request still hides the schema.
    expect(toolNames(llm.calls[1]!.tools)).not.toContain("mcp__srv__probe")
    expect([...runtime.deferred.activated]).toEqual([])
  } finally {
    restore()
  }
})

test("activation persists across turns within a runtime", async () => {
  const restore = withApiKey()
  try {
    const runs: string[] = []
    const { config, runtime } = setup(runs)
    const session = createSession("/tmp/zcode-test")
    const signal = new AbortController().signal

    const first = mockLLM([
      { toolCalls: [{ callId: "s1", name: TOOL_SEARCH_NAME, input: { query: "probe" } }] },
      { text: "found it" },
    ])
    await collect(query({ prompt: "look it up", session, config, runtime, signal, deps: { llm: first.fn } }))

    const second = mockLLM([{ text: "still here" }])
    await collect(query({ prompt: "again", session, config, runtime, signal, deps: { llm: second.fn } }))

    // No second search was needed.
    const decl = second.calls[0]!.tools.find((tool) => tool.name === "mcp__srv__probe")
    expect(decl).toBeDefined()
    expect(JSON.stringify(decl?.inputSchema)).toContain("host to probe")
  } finally {
    restore()
  }
})

test("toolsearch calls never emit permission-ask", async () => {
  const restore = withApiKey()
  try {
    const runs: string[] = []
    const { config, runtime } = setup(runs)
    const session = createSession("/tmp/zcode-test")
    const llm = mockLLM([
      { toolCalls: [{ callId: "s1", name: TOOL_SEARCH_NAME, input: { query: "probe" } }] },
      { text: "done" },
    ])

    const events = await collect(
      query({
        prompt: "search",
        session,
        config,
        runtime,
        signal: new AbortController().signal,
        deps: { llm: llm.fn },
      }),
    )

    expect(events.some((event) => event.type === "permission-ask")).toBe(false)
    const toolEnd = events.find(
      (event): event is Extract<AgentEvent, { type: "tool-end" }> => event.type === "tool-end",
    )
    expect(toolEnd?.result.status).toBe("ok")
    expect([...runtime.deferred.activated]).toEqual(["mcp__srv__probe"])
  } finally {
    restore()
  }
})

test("a deps.toolNames allowlist cannot unhide a deferred tool", async () => {
  const restore = withApiKey()
  try {
    const runs: string[] = []
    const { config, runtime } = setup(runs)
    const session = createSession("/tmp/zcode-test")
    const llm = mockLLM([{ text: "nothing to do" }])

    await collect(
      query({
        prompt: "hi",
        session,
        config,
        runtime,
        signal: new AbortController().signal,
        deps: { llm: llm.fn, toolNames: ["mcp__srv__probe", TOOL_SEARCH_NAME] },
      }),
    )

    expect(toolNames(llm.calls[0]!.tools)).toEqual([TOOL_SEARCH_NAME])
  } finally {
    restore()
  }
})

test("a non-deferring server keeps its tools visible with no toolsearch overhead", async () => {
  const restore = withApiKey()
  try {
    const runs: string[] = []
    const config = testConfig({
      mcp: { servers: { srv: { type: "stdio", command: "bun", args: [], env: {}, defer: false } } },
    })
    const runtime = testRuntime(config, [probeTool(runs)])
    runtime.registry.register(createToolSearchTool(runtime))
    const session = createSession("/tmp/zcode-test")
    const llm = mockLLM([{ text: "ok" }])

    await collect(
      query({ prompt: "hi", session, config, runtime, signal: new AbortController().signal, deps: { llm: llm.fn } }),
    )

    expect(toolNames(llm.calls[0]!.tools)).toContain("mcp__srv__probe")
    expect(toolNames(llm.calls[0]!.tools)).not.toContain(TOOL_SEARCH_NAME)
  } finally {
    restore()
  }
})
