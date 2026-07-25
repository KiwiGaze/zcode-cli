import { generateText } from "ai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import type { EndpointKind, ProviderId } from "@/llm/providers"

const DEFAULT_MAX_OUTPUT_TOKENS = 1024

export interface CompleteRequest {
  provider: ProviderId
  model: string
  endpointKind: EndpointKind
  baseUrl: string
  apiKey: string
  system: string
  /** The single user message. */
  prompt: string
  maxOutputTokens?: number
  temperature?: number
  signal: AbortSignal
  /** Test seam: overrides the HTTP transport. */
  fetchOverride?: typeof fetch
}

export type CompleteFn = (request: CompleteRequest) => Promise<string>

/**
 * One non-streaming, tool-free call for side queries. GLM thinking is deliberately left off —
 * `streamLLM` enables it dialect-wide, which would spend reasoning tokens on a short
 * classification — and `temperature` defaults to 0 rather than the server default.
 */
export const complete: CompleteFn = async (request) => {
  const client = createOpenAICompatible({
    name: request.provider,
    baseURL: request.baseUrl,
    apiKey: request.apiKey,
    ...(request.fetchOverride === undefined ? {} : { fetch: request.fetchOverride }),
  })
  const result = await generateText({
    model: client.chatModel(request.model),
    ...(request.system.length > 0 ? { system: request.system } : {}),
    prompt: request.prompt,
    temperature: request.temperature ?? 0,
    maxOutputTokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    abortSignal: request.signal,
    maxRetries: 0,
  })
  return result.text
}
