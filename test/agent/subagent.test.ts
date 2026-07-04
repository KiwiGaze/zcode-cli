import { test, expect } from "bun:test"
import { query } from "@/agent/query"
import { createRuntime } from "@/agent/runtime"
import { createSession } from "@/session/session"
import type { AgentEvent } from "@/agent/events"
import { mockLLM, type MockTurn } from "../support/mock-llm"
import { testConfig, withApiKey } from "../support/config"

async function collect(gen: AsyncGenerator<AgentEvent, void>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of gen) events.push(event)
  return events
}

test("task tool runs a subagent and returns its final text", async () => {
  const restore = withApiKey()
  try {
    const config = testConfig()
    const session = createSession("/tmp/zcode-test")
    const runtime = createRuntime(config)
    // Parent asks for a subagent; subagent replies; parent summarizes.
    const turns: MockTurn[] = [
      { toolCalls: [{ callId: "c1", name: "task", input: { description: "look", prompt: "find the answer" } }] },
      { text: "the subagent said 42" }, // subagent turn
      { text: "final: 42" }, // parent turn after tool result
    ]
    const llm = mockLLM(turns)
    runtime.llm = llm.fn
    const events = await collect(
      query({ prompt: "delegate", session, config, runtime, signal: new AbortController().signal, deps: { llm: llm.fn } }),
    )
    const toolEnd = events.find((e): e is Extract<AgentEvent, { type: "tool-end" }> => e.type === "tool-end")
    expect(toolEnd?.result.status).toBe("ok")
    expect(toolEnd?.result.output).toContain("42")
    // parent + subagent + parent = 3 model calls
    expect(llm.calls).toHaveLength(3)
  } finally {
    restore()
  }
})

test("subagents cannot spawn further subagents (task excluded from child toolset)", async () => {
  const restore = withApiKey()
  try {
    const config = testConfig()
    const session = createSession("/tmp/zcode-test")
    const runtime = createRuntime(config)
    const turns: MockTurn[] = [
      { toolCalls: [{ callId: "c1", name: "task", input: { description: "look", prompt: "search" } }] },
      { text: "subagent result" },
      { text: "done" },
    ]
    const llm = mockLLM(turns)
    runtime.llm = llm.fn
    await collect(
      query({ prompt: "go", session, config, runtime, signal: new AbortController().signal, deps: { llm: llm.fn } }),
    )
    // second call is the subagent — its tool declarations must exclude "task"
    const subagentTools = llm.calls[1]?.tools.map((tool) => tool.name) ?? []
    expect(subagentTools).not.toContain("task")
    expect(subagentTools).toContain("read")
    expect(subagentTools).not.toContain("bash")
  } finally {
    restore()
  }
})
