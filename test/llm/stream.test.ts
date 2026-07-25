import { expect, test } from "bun:test"
import { streamLLM } from "@/llm/stream"
import type { UserMessage } from "@/session/messages"

function completionStream(): Response {
  const chunks = [
    {
      id: "chat-1",
      object: "chat.completion.chunk",
      created: 1,
      model: "glm-5.2",
      choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
    },
    {
      id: "chat-1",
      object: "chat.completion.chunk",
      created: 1,
      model: "glm-5.2",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 2,
        completion_tokens: 1,
        total_tokens: 3,
        prompt_tokens_details: { cached_tokens: 0 },
      },
    },
  ]
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join("\n\n")}\n\ndata: [DONE]\n\n`
  return new Response(body, { headers: { "content-type": "text/event-stream" } })
}

function userContent(requestBody: unknown): unknown {
  if (typeof requestBody !== "object" || requestBody === null) {
    throw new Error("Expected the provider request body to be an object.")
  }
  const messages = (requestBody as Record<string, unknown>)["messages"]
  if (!Array.isArray(messages)) throw new Error("Expected the provider request body to contain messages.")
  const user = messages.find(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      (message as Record<string, unknown>)["role"] === "user",
  )
  if (typeof user !== "object" || user === null) throw new Error("Expected a provider-facing user message.")
  return (user as Record<string, unknown>)["content"]
}

test("multi-part text user messages serialize as string content", async () => {
  const message: UserMessage = {
    type: "user",
    id: "u1",
    ts: 1,
    content: [
      { type: "text", text: "session context\n\n" },
      { type: "text", text: "raw prompt" },
    ],
  }
  let requestBody: unknown
  const fetchOverride = Object.assign(
    async (...args: Parameters<typeof fetch>): Promise<Response> => {
      const init = args[1]
      if (typeof init?.body !== "string") throw new Error("Expected a JSON request body.")
      requestBody = JSON.parse(init.body) as unknown
      return completionStream()
    },
    { preconnect: fetch.preconnect },
  ) satisfies typeof fetch

  for await (const _event of streamLLM({
    provider: "zai",
    model: "glm-5.2",
    endpointKind: "coding",
    baseUrl: "https://example.invalid/v4",
    apiKey: "test-key",
    system: "identity",
    messages: [message],
    tools: [],
    signal: new AbortController().signal,
    fetchOverride,
  })) {
  }

  expect(userContent(requestBody)).toBe("session context\n\nraw prompt")
})
