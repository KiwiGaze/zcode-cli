import type { ChatItem, TokenUsage } from "@/session/messages"
import type { EndpointKind, ProviderId } from "@/llm/providers"

export interface LLMToolDecl {
  name: string
  description: string
  /** JSON Schema for the tool input. */
  inputSchema: Record<string, unknown>
}

export type LLMFinishReason = "stop" | "tool-calls" | "length" | "content-filter" | "other"

export type LLMStreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call"; callId: string; name: string; input: unknown; invalid?: string }
  | { type: "finish"; reason: LLMFinishReason; usage: TokenUsage }

export interface LLMRequest {
  provider: ProviderId
  model: string
  endpointKind: EndpointKind
  baseUrl: string
  apiKey: string
  system: string
  messages: ChatItem[]
  tools: LLMToolDecl[]
  reasoningEffort?: "high" | "max"
  maxOutputTokens?: number
  signal: AbortSignal
  /** Test seam: overrides the HTTP transport. */
  fetchOverride?: typeof fetch
}

export type LLMStreamFn = (request: LLMRequest) => AsyncGenerator<LLMStreamEvent, void>
