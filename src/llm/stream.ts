import { APICallError, jsonSchema, streamText, tool, type ModelMessage, type Tool } from "ai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import type { LLMRequest, LLMStreamEvent, LLMStreamFn, LLMFinishReason, LLMToolDecl } from "@/llm/types"
import type { ChatItem, TokenUsage } from "@/session/messages"
import { ZCodeError } from "@/util/errors"

const STREAM_RETRIES = 2

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export const streamLLM: LLMStreamFn = async function* (request) {
  for (let attempt = 0; ; attempt++) {
    let emitted = false
    try {
      for await (const event of runOnce(request)) {
        emitted = true
        yield event
      }
      return
    } catch (error) {
      const mapped = mapError(error)
      if (!emitted && mapped.retryable && attempt < STREAM_RETRIES && !request.signal.aborted) {
        await backoff(attempt, request.signal)
        continue
      }
      throw mapped
    }
  }
}

async function* runOnce(request: LLMRequest): AsyncGenerator<LLMStreamEvent, void> {
  const client = createOpenAICompatible({
    name: request.provider,
    baseURL: request.baseUrl,
    apiKey: request.apiKey,
    ...(request.fetchOverride === undefined ? {} : { fetch: request.fetchOverride }),
  })

  const result = streamText({
    model: client.chatModel(request.model),
    system: request.system.length > 0 ? request.system : undefined,
    messages: toModelMessages(request.messages),
    tools: toTools(request.tools),
    temperature: defaultTemperature(request.model),
    maxOutputTokens: request.maxOutputTokens,
    abortSignal: request.signal,
    maxRetries: 0,
    providerOptions: { [request.provider]: glmProviderOptions(request) },
    onError: () => {},
  })

  let finish: LLMStreamEvent | undefined
  for await (const part of result.fullStream) {
    switch (part.type) {
      case "text-delta":
        if (part.text.length > 0) yield { type: "text-delta", text: part.text }
        break
      case "reasoning-delta":
        if (part.text.length > 0) yield { type: "reasoning-delta", text: part.text }
        break
      case "tool-call": {
        const invalid = part.dynamic === true && part.invalid === true
        yield {
          type: "tool-call",
          callId: part.toolCallId,
          name: part.toolName,
          input: part.input,
          ...(invalid ? { invalid: part.error === undefined ? "unparsable tool call" : String(part.error) } : {}),
        }
        break
      }
      case "finish-step":
        finish = { type: "finish", reason: mapFinishReason(part.finishReason), usage: toUsage(part.usage) }
        break
      case "error":
        throw part.error
      case "abort":
        return
      default:
        break
    }
  }
  if (finish !== undefined) yield finish
}

/**
 * GLM dialect (ported from opencode provider/transform.ts):
 * - `thinking: {type: enabled}` turns reasoning on for zai/bigmodel models.
 * - `reasoningEffort` maps to `reasoning_effort`, supported by glm-5.2 only.
 */
function glmProviderOptions(request: LLMRequest): Record<string, JsonValue> {
  const options: Record<string, JsonValue> = {
    thinking: { type: "enabled", clear_thinking: false },
  }
  if (request.reasoningEffort !== undefined && isGlm52(request.model)) {
    options["reasoningEffort"] = request.reasoningEffort
  }
  return options
}

function isGlm52(model: string): boolean {
  const id = model.toLowerCase()
  return ["glm-5.2", "glm-5-2", "glm-5p2"].some((name) => id.includes(name))
}

function defaultTemperature(model: string): number | undefined {
  const id = model.toLowerCase()
  if (id.includes("glm-4.6") || id.includes("glm-4.7")) return 1.0
  return undefined
}

type AssistantContent = Exclude<Extract<ModelMessage, { role: "assistant" }>["content"], string>

export function toModelMessages(items: ChatItem[]): ModelMessage[] {
  const out: ModelMessage[] = []
  for (const item of items) {
    switch (item.type) {
      case "user":
        out.push({
          role: "user",
          content: item.content.map((part) => part.text).join(""),
        })
        break
      case "assistant": {
        const content: AssistantContent = []
        for (const part of item.parts) {
          if (part.type === "text") content.push({ type: "text", text: part.text })
          else if (part.type === "reasoning") content.push({ type: "reasoning", text: part.text })
          else content.push({ type: "tool-call", toolCallId: part.callId, toolName: part.name, input: part.input })
        }
        const meaningful = content.some((part) => part.type === "text" || part.type === "tool-call")
        if (meaningful) out.push({ role: "assistant", content })
        break
      }
      case "tool-result":
        out.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: item.callId,
              toolName: item.name,
              output:
                item.result.status === "ok"
                  ? { type: "text", value: item.result.output }
                  : { type: "error-text", value: item.result.output },
            },
          ],
        })
        break
    }
  }
  return out
}

function toTools(decls: LLMToolDecl[]): Record<string, Tool> | undefined {
  if (decls.length === 0) return undefined
  return Object.fromEntries(
    decls.map((decl) => [
      decl.name,
      tool({ description: decl.description, inputSchema: jsonSchema<unknown>(decl.inputSchema) }),
    ]),
  )
}

interface StreamUsageLike {
  inputTokens: number | undefined
  outputTokens: number | undefined
  inputTokenDetails: { cacheReadTokens: number | undefined }
  outputTokenDetails: { reasoningTokens: number | undefined }
}

function toUsage(usage: StreamUsageLike): TokenUsage {
  return {
    input: usage.inputTokens ?? 0,
    output: usage.outputTokens ?? 0,
    reasoning: usage.outputTokenDetails.reasoningTokens ?? 0,
    cachedInput: usage.inputTokenDetails.cacheReadTokens ?? 0,
  }
}

function mapFinishReason(reason: string): LLMFinishReason {
  switch (reason) {
    case "stop":
      return "stop"
    case "tool-calls":
      return "tool-calls"
    case "length":
      return "length"
    case "content-filter":
      return "content-filter"
    default:
      return "other"
  }
}

function mapError(error: unknown): ZCodeError {
  if (error instanceof ZCodeError) return error
  if (APICallError.isInstance(error)) {
    const status = error.statusCode
    const detail = compactApiMessage(error)
    if (status === 401 || status === 403) {
      return new ZCodeError("auth", `authentication failed (${status}): ${detail}`, { cause: error })
    }
    if (status === 429) {
      return new ZCodeError("rate-limit", `rate limited: ${detail}`, { retryable: true, cause: error })
    }
    return new ZCodeError("api", `API error${status === undefined ? "" : ` (${status})`}: ${detail}`, {
      retryable: error.isRetryable,
      cause: error,
    })
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new ZCodeError("aborted", "interrupted")
  }
  if (error instanceof Error) {
    const cause = error.cause
    if (cause instanceof Error && "code" in cause && typeof cause.code === "string") {
      return new ZCodeError("api", `network error: ${cause.code}`, { retryable: true, cause: error })
    }
    return new ZCodeError("api", error.message, { cause: error })
  }
  return new ZCodeError("api", String(error))
}

function compactApiMessage(error: APICallError): string {
  const body = error.responseBody
  if (typeof body === "string" && body.length > 0) {
    try {
      const parsed: unknown = JSON.parse(body)
      if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
        const inner = (parsed as { error: unknown }).error
        if (typeof inner === "object" && inner !== null && "message" in inner) {
          const message = (inner as { message: unknown }).message
          if (typeof message === "string") return message
        }
      }
    } catch {
      // fall through to error.message
    }
  }
  return error.message
}

function backoff(attempt: number, signal: AbortSignal): Promise<void> {
  const delay = Math.min(4000, 500 * 2 ** attempt) * (0.5 + Math.random() * 0.5)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, delay)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new ZCodeError("aborted", "interrupted"))
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}
