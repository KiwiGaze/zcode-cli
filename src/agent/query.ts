import type { AgentEvent } from "@/agent/events"
import { buildSystemPrompt } from "@/agent/system"
import type { ResolvedConfig } from "@/config/config"
import { modelInfo } from "@/config/config"
import { baseUrl, requireApiKey } from "@/llm/providers"
import { streamLLM } from "@/llm/stream"
import type { LLMStreamFn } from "@/llm/types"
import {
  addUsage,
  EMPTY_USAGE,
  userMessage,
  type AssistantMessage,
  type AssistantPart,
} from "@/session/messages"
import type { Session } from "@/session/session"
import { toZCodeError } from "@/util/errors"
import { newId } from "@/util/id"

const DEFAULT_MAX_OUTPUT_TOKENS = 32_768

export interface QueryDeps {
  llm?: LLMStreamFn
}

export interface QueryInput {
  prompt: string
  session: Session
  config: ResolvedConfig
  signal: AbortSignal
  deps?: QueryDeps
}

export async function* query(input: QueryInput): AsyncGenerator<AgentEvent, void> {
  const { session, config, signal } = input
  const llm = input.deps?.llm ?? streamLLM

  session.items.push(userMessage(newId("msg"), input.prompt))

  const message: AssistantMessage = {
    type: "assistant",
    id: newId("msg"),
    ts: Date.now(),
    provider: config.provider,
    model: config.model,
    parts: [],
    usage: { ...EMPTY_USAGE },
    stopReason: "end",
  }
  yield { type: "message-start", role: "assistant", messageId: message.id }

  try {
    const stream = llm({
      provider: config.provider,
      model: config.model,
      endpointKind: config.endpointKind,
      baseUrl: baseUrl(config.provider, config.endpointKind),
      apiKey: requireApiKey(config.provider, config),
      system: buildSystemPrompt(config),
      messages: session.items,
      tools: [],
      ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
      maxOutputTokens: resolveMaxOutputTokens(config),
      signal,
    })
    for await (const event of stream) {
      switch (event.type) {
        case "text-delta":
          appendPart(message, "text", event.text)
          yield { type: "text-delta", messageId: message.id, delta: event.text }
          break
        case "reasoning-delta":
          appendPart(message, "reasoning", event.text)
          yield { type: "reasoning-delta", messageId: message.id, delta: event.text }
          break
        case "tool-call":
          break
        case "finish":
          message.usage = event.usage
          session.totalUsage = addUsage(session.totalUsage, event.usage)
          yield { type: "step-usage", usage: event.usage }
          break
      }
    }
  } catch (error) {
    const mapped = toZCodeError(error)
    if (mapped.code === "aborted" || signal.aborted) {
      finalize(session, message, "aborted")
      yield { type: "done", message }
      return
    }
    finalize(session, message, "error")
    yield { type: "error", error: mapped.toAgentError() }
    return
  }

  finalize(session, message, signal.aborted ? "aborted" : "end")
  yield { type: "done", message }
}

function finalize(session: Session, message: AssistantMessage, stopReason: AssistantMessage["stopReason"]): void {
  message.stopReason = stopReason
  if (message.parts.length > 0) session.items.push(message)
}

function appendPart(message: AssistantMessage, type: "text" | "reasoning", text: string): void {
  const last = message.parts[message.parts.length - 1]
  if (last !== undefined && last.type === type) {
    last.text += text
    return
  }
  message.parts.push({ type, text } as AssistantPart)
}

export function resolveMaxOutputTokens(config: ResolvedConfig): number {
  const info = modelInfo(config, config.model)
  const cap = info?.maxOutput ?? DEFAULT_MAX_OUTPUT_TOKENS
  return Math.min(config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS, cap)
}
