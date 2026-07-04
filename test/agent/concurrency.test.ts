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

function slowTool(order: string[]): AnyTool {
  return defineTool<{ id: string; delay: number }>({
    name: "slow",
    description: "a tool that waits",
    inputSchema: z.object({ id: z.string(), delay: z.number() }),
    permission: () => null,
    execute: async (input) => {
      await new Promise((resolve) => setTimeout(resolve, input.delay))
      order.push(input.id)
      return okResult(`done ${input.id}`)
    },
  })
}

test("independent tool calls in one turn run concurrently", async () => {
  const restore = withApiKey()
  try {
    const config = testConfig()
    const session = createSession("/tmp/zcode-test")
    const order: string[] = []
    const runtime = testRuntime(config, [slowTool(order)])
    const llm = mockLLM([
      {
        toolCalls: [
          { callId: "a", name: "slow", input: { id: "a", delay: 60 } },
          { callId: "b", name: "slow", input: { id: "b", delay: 10 } },
        ],
      },
      { text: "done" },
    ])

    const start = performance.now()
    const events: AgentEvent[] = []
    for await (const event of query({
      prompt: "run both",
      session,
      config,
      runtime,
      signal: new AbortController().signal,
      deps: { llm: llm.fn },
    })) {
      events.push(event)
    }
    const elapsed = performance.now() - start

    // Concurrent: the faster tool (b) finishes before the slower one (a).
    expect(order).toEqual(["b", "a"])
    // Wall clock is near the slowest (60ms), not the sum (70ms).
    expect(elapsed).toBeLessThan(120)
    // Both tool results recorded, in call order.
    const toolResults = session.items.filter((item) => item.type === "tool-result")
    expect(toolResults).toHaveLength(2)
    expect(toolResults[0]?.type === "tool-result" ? toolResults[0].callId : "").toBe("a")
    expect(toolResults[1]?.type === "tool-result" ? toolResults[1].callId : "").toBe("b")
  } finally {
    restore()
  }
})
