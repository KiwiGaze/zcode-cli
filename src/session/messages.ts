import type { ToolResult } from "@/tools/types"

export interface TokenUsage {
  input: number
  output: number
  reasoning: number
  cachedInput: number
}

export interface ModelUsage {
  model: string
  usage: TokenUsage
}

export const EMPTY_USAGE: TokenUsage = { input: 0, output: 0, reasoning: 0, cachedInput: 0 }

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cachedInput: a.cachedInput + b.cachedInput,
  }
}

export type UserContent = { type: "text"; text: string }

export interface UserMessage {
  type: "user"
  id: string
  ts: number
  content: UserContent[]
}

export type AssistantPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; callId: string; name: string; input: unknown }

export type StopReason = "end" | "tool-calls" | "aborted" | "error"

export interface AssistantMessage {
  type: "assistant"
  id: string
  ts: number
  provider: string
  model: string
  parts: AssistantPart[]
  usage: TokenUsage
  stopReason: StopReason
}

export interface ToolResultItem {
  type: "tool-result"
  callId: string
  name: string
  result: ToolResult
}

export type ChatItem = UserMessage | AssistantMessage | ToolResultItem

export function userMessage(id: string, text: string): UserMessage {
  return { type: "user", id, ts: Date.now(), content: [{ type: "text", text }] }
}

export function assistantText(message: AssistantMessage): string {
  return message.parts
    .filter((part): part is Extract<AssistantPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("")
}
