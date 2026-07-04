import { test, expect } from "bun:test"
import { query } from "@/agent/query"
import { createSession } from "@/session/session"
import { defineTool, type AnyTool } from "@/tools/registry"
import { okResult } from "@/tools/types"
import type { AgentEvent } from "@/agent/events"
import { z } from "zod"
import { mockLLM } from "../support/mock-llm"
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

function askTool(): AnyTool {
  return defineTool<{ path: string }>({
    name: "danger",
    description: "a tool that needs approval",
    inputSchema: z.object({ path: z.string() }),
    permission: (input, ctx) => ({
      tool: "danger",
      callId: ctx.callId,
      title: `danger: ${input.path}`,
      key: `danger:${input.path}`,
      subject: input.path,
    }),
    execute: async () => okResult("did the dangerous thing"),
  })
}

test("the loop executes a tool call and feeds the result into the next turn", async () => {
  const restore = withApiKey()
  try {
    const config = testConfig()
    const session = createSession("/tmp/zcode-test")
    const calls: string[] = []
    const runtime = testRuntime(config, [echoTool(calls)])
    const llm = mockLLM([
      { text: "let me echo", toolCalls: [{ callId: "c1", name: "echo", input: { text: "hi" } }] },
      { text: "done" },
    ])

    const events = await collect(
      query({ prompt: "please echo hi", session, config, runtime, signal: new AbortController().signal, deps: { llm: llm.fn } }),
    )

    expect(calls).toEqual(["hi"])
    const toolEnd = events.find((e) => e.type === "tool-end")
    expect(toolEnd).toBeDefined()
    expect(llm.calls).toHaveLength(2)
    // second turn must include the tool result
    expect(session.items.some((item) => item.type === "tool-result")).toBe(true)
  } finally {
    restore()
  }
})

test("config-level deny short-circuits execution", async () => {
  const restore = withApiKey()
  try {
    const config = testConfig({ permissions: { danger: "deny" } })
    const session = createSession("/tmp/zcode-test")
    const runtime = testRuntime(config, [askTool()])
    const llm = mockLLM([
      { toolCalls: [{ callId: "c1", name: "danger", input: { path: "/etc" } }] },
      { text: "understood" },
    ])
    const events = await collect(
      query({ prompt: "do danger", session, config, runtime, signal: new AbortController().signal, deps: { llm: llm.fn } }),
    )
    const toolEnd = events.find((e): e is Extract<AgentEvent, { type: "tool-end" }> => e.type === "tool-end")
    expect(toolEnd?.result.status).toBe("denied")
  } finally {
    restore()
  }
})

test("an ask permission is resolved through the permission-ask event", async () => {
  const restore = withApiKey()
  try {
    const config = testConfig({ permissions: { danger: "ask" } })
    const session = createSession("/tmp/zcode-test")
    const runtime = testRuntime(config, [askTool()])
    const llm = mockLLM([
      { toolCalls: [{ callId: "c1", name: "danger", input: { path: "/etc" } }] },
      { text: "ok" },
    ])
    const events: AgentEvent[] = []
    for await (const event of query({
      prompt: "do danger",
      session,
      config,
      runtime,
      signal: new AbortController().signal,
      deps: { llm: llm.fn },
    })) {
      if (event.type === "permission-ask") event.respond("allow-once")
      events.push(event)
    }
    const toolEnd = events.find((e): e is Extract<AgentEvent, { type: "tool-end" }> => e.type === "tool-end")
    expect(toolEnd?.result.status).toBe("ok")
    expect(events.some((e) => e.type === "permission-ask")).toBe(true)
  } finally {
    restore()
  }
})

test("plan mode denies a mutating tool structurally", async () => {
  const restore = withApiKey()
  try {
    const config = testConfig()
    const session = createSession("/tmp/zcode-test")
    const runtime = testRuntime(config, [
      defineTool<{ path: string }>({
        name: "bash",
        description: "run",
        inputSchema: z.object({ path: z.string() }),
        permission: (input, ctx) => ({ tool: "bash", callId: ctx.callId, title: "bash", key: "bash:x", subject: input.path }),
        execute: async () => okResult("ran"),
      }),
    ])
    runtime.permissions.setPlanMode(true)
    const llm = mockLLM([
      { toolCalls: [{ callId: "c1", name: "bash", input: { path: "rm -rf /" } }] },
      { text: "blocked" },
    ])
    const events: AgentEvent[] = []
    for await (const event of query({
      prompt: "delete everything",
      session,
      config,
      runtime,
      signal: new AbortController().signal,
      deps: { llm: llm.fn },
    })) {
      events.push(event)
    }
    const toolEnd = events.find((e): e is Extract<AgentEvent, { type: "tool-end" }> => e.type === "tool-end")
    expect(toolEnd?.result.status).toBe("denied")
    expect(events.some((e) => e.type === "permission-ask")).toBe(false)
  } finally {
    restore()
  }
})
