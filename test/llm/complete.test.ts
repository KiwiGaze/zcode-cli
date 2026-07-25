import { expect, test } from "bun:test"
import { complete } from "@/llm/complete"
import type { ModelUsage } from "@/session/messages"

function completionBody(text: string): Response {
  return new Response(
    JSON.stringify({
      id: "chat-1",
      object: "chat.completion",
      created: 1,
      model: "glm-5.2",
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }),
    { headers: { "content-type": "application/json" } },
  )
}

function capture(reply: string): { fetchOverride: typeof fetch; body: () => Record<string, unknown> } {
  let seen: Record<string, unknown> | undefined
  const fetchOverride = Object.assign(
    async (...args: Parameters<typeof fetch>): Promise<Response> => {
      const init = args[1]
      if (typeof init?.body !== "string") throw new Error("Expected a JSON request body.")
      seen = JSON.parse(init.body) as Record<string, unknown>
      return completionBody(reply)
    },
    { preconnect: fetch.preconnect },
  ) satisfies typeof fetch
  return {
    fetchOverride,
    body: () => {
      if (seen === undefined) throw new Error("The provider was never called.")
      return seen
    },
  }
}

test("a side call sends one user message with thinking off and temperature pinned", async () => {
  const captured = capture("verdict")

  const text = await complete({
    provider: "zai",
    model: "glm-5.2",
    endpointKind: "coding",
    baseUrl: "https://example.invalid/v4",
    apiKey: "test-key",
    system: "you are a classifier",
    prompt: "classify this",
    maxOutputTokens: 256,
    signal: new AbortController().signal,
    fetchOverride: captured.fetchOverride,
  })

  expect(text).toBe("verdict")
  const body = captured.body()
  // GLM thinking is enabled dialect-wide for the streaming path; a 256-token side call must not pay for it.
  expect(body["thinking"]).toBeUndefined()
  expect(body["temperature"]).toBe(0)
  expect(body["max_tokens"]).toBe(256)
  expect(body["stream"]).not.toBe(true)
  expect(body["tools"]).toBeUndefined()

  const messages = body["messages"]
  expect(Array.isArray(messages)).toBe(true)
  const roles = (messages as { role: string }[]).map((message) => message.role)
  expect(roles).toEqual(["system", "user"])
})

test("an explicit temperature overrides the pinned default", async () => {
  const captured = capture("ok")

  await complete({
    provider: "zai",
    model: "glm-5.2",
    endpointKind: "coding",
    baseUrl: "https://example.invalid/v4",
    apiKey: "test-key",
    system: "",
    prompt: "hello",
    temperature: 0.7,
    signal: new AbortController().signal,
    fetchOverride: captured.fetchOverride,
  })

  const body = captured.body()
  expect(body["temperature"]).toBe(0.7)
  expect((body["messages"] as { role: string }[]).map((message) => message.role)).toEqual(["user"])
})

test("a side call reports provider usage to its owning session", async () => {
  const captured = capture("ok")
  const usages: ModelUsage[] = []

  await complete({
    provider: "zai",
    model: "glm-5.2",
    endpointKind: "coding",
    baseUrl: "https://example.invalid/v4",
    apiKey: "test-key",
    system: "",
    prompt: "hello",
    signal: new AbortController().signal,
    fetchOverride: captured.fetchOverride,
    onUsage: (usage) => usages.push(usage),
  })

  expect(usages).toEqual([
    { model: "glm-5.2", usage: { input: 2, output: 1, reasoning: 0, cachedInput: 0 } },
  ])
})
