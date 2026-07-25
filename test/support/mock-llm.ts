import type { LLMStreamEvent, LLMStreamFn, LLMToolDecl } from "@/llm/types"
import type { ChatItem, TokenUsage } from "@/session/messages"

export interface MockTurn {
  reasoning?: string
  text?: string
  toolCalls?: { callId: string; name: string; input: unknown }[]
  usage?: Partial<TokenUsage>
  finish?: "stop" | "tool-calls"
}

export interface MockCall {
  system: string
  messages: ChatItem[]
  tools: LLMToolDecl[]
}

export interface MockLLM {
  fn: LLMStreamFn
  calls: MockCall[]
}

export function mockLLM(turns: MockTurn[]): MockLLM {
  const calls: MockCall[] = []
  let index = 0
  const fn: LLMStreamFn = async function* (request) {
    calls.push({ system: request.system, messages: [...request.messages], tools: request.tools })
    const turn = turns[index] ?? {}
    index += 1
    if (turn.reasoning !== undefined) {
      for (const chunk of splitChunks(turn.reasoning)) yield { type: "reasoning-delta", text: chunk }
    }
    if (turn.text !== undefined) {
      for (const chunk of splitChunks(turn.text)) yield { type: "text-delta", text: chunk }
    }
    for (const call of turn.toolCalls ?? []) {
      yield { type: "tool-call", callId: call.callId, name: call.name, input: call.input }
    }
    const usage: TokenUsage = {
      input: turn.usage?.input ?? 10,
      output: turn.usage?.output ?? 5,
      reasoning: turn.usage?.reasoning ?? 0,
      cachedInput: turn.usage?.cachedInput ?? 0,
    }
    const reason = turn.finish ?? (turn.toolCalls && turn.toolCalls.length > 0 ? "tool-calls" : "stop")
    yield { type: "finish", reason, usage } satisfies LLMStreamEvent
  }
  return { fn, calls }
}

function splitChunks(text: string): string[] {
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += 4) chunks.push(text.slice(i, i + 4))
  return chunks
}
