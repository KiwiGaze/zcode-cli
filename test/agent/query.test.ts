import { test, expect } from "bun:test"
import { query } from "@/agent/query"
import { createSession } from "@/session/session"
import { assistantText, type AssistantMessage } from "@/session/messages"
import type { AgentEvent } from "@/agent/events"
import { mockLLM } from "../support/mock-llm"
import { testConfig, withApiKey } from "../support/config"

async function collect(gen: AsyncGenerator<AgentEvent, void>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of gen) events.push(event)
  return events
}

test("query separates reasoning from text and records the assistant message", async () => {
  const restore = withApiKey()
  try {
    const session = createSession("/tmp/zcode-test")
    const config = testConfig()
    const llm = mockLLM([{ reasoning: "thinking hard", text: "hello world", usage: { input: 20, output: 8 } }])
    const events = await collect(
      query({ prompt: "hi", session, config, signal: new AbortController().signal, deps: { llm: llm.fn } }),
    )

    const reasoning = events.filter((e) => e.type === "reasoning-delta").map((e) => (e as { delta: string }).delta).join("")
    const text = events.filter((e) => e.type === "text-delta").map((e) => (e as { delta: string }).delta).join("")
    expect(reasoning).toBe("thinking hard")
    expect(text).toBe("hello world")

    const done = events.find((e) => e.type === "done")
    expect(done).toBeDefined()
    const message = (done as { message: AssistantMessage }).message
    expect(assistantText(message)).toBe("hello world")
    expect(message.parts[0]).toEqual({ type: "reasoning", text: "thinking hard" })

    expect(session.items).toHaveLength(2)
    expect(session.items[0]?.type).toBe("user")
    expect(session.items[1]?.type).toBe("assistant")
    expect(session.totalUsage.input).toBe(20)
    expect(session.totalUsage.output).toBe(8)
  } finally {
    restore()
  }
})

test("query passes prior history to the model on the next turn", async () => {
  const restore = withApiKey()
  try {
    const session = createSession("/tmp/zcode-test")
    const config = testConfig()
    const llm = mockLLM([{ text: "first" }, { text: "second" }])
    await collect(query({ prompt: "one", session, config, signal: new AbortController().signal, deps: { llm: llm.fn } }))
    await collect(query({ prompt: "two", session, config, signal: new AbortController().signal, deps: { llm: llm.fn } }))
    expect(llm.calls).toHaveLength(2)
    expect(llm.calls[1]?.messages.length).toBe(3)
  } finally {
    restore()
  }
})

test("aborted query yields done with aborted stop reason", async () => {
  const restore = withApiKey()
  try {
    const session = createSession("/tmp/zcode-test")
    const config = testConfig()
    const controller = new AbortController()
    const llm = mockLLM([{ text: "partial" }])
    const gen = query({ prompt: "hi", session, config, signal: controller.signal, deps: { llm: llm.fn } })
    controller.abort()
    const events = await collect(gen)
    const done = events.find((e) => e.type === "done")
    expect(done).toBeDefined()
  } finally {
    restore()
  }
})
