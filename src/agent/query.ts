import type { AgentEvent } from "@/agent/events"
import { buildSystemPrompt } from "@/agent/system"
import { projectForModel } from "@/agent/compact"
import type { AgentRuntime } from "@/agent/runtime"
import type { ResolvedConfig } from "@/config/config"
import { modelInfo } from "@/config/config"
import { baseUrl, requireApiKey } from "@/llm/providers"
import { streamLLM } from "@/llm/stream"
import type { LLMStreamEvent, LLMStreamFn } from "@/llm/types"
import {
  addUsage,
  EMPTY_USAGE,
  userMessage,
  type AssistantMessage,
  type AssistantPart,
  type ToolResultItem,
} from "@/session/messages"
import type { Session } from "@/session/session"
import type { ToolResult } from "@/tools/types"
import type { ToolContext } from "@/tools/registry"
import type { PermissionDecision, PermissionRequest } from "@/permissions/types"
import { planModeDenyMessage } from "@/permissions/policy"
import { toZCodeError } from "@/util/errors"
import { newId } from "@/util/id"

const DEFAULT_MAX_OUTPUT_TOKENS = 32_768
const MAX_STEPS = 50

export interface QueryDeps {
  llm?: LLMStreamFn
  system?: string
  toolNames?: string[]
}

export interface QueryInput {
  prompt: string
  session: Session
  config: ResolvedConfig
  runtime: AgentRuntime
  signal: AbortSignal
  deps?: QueryDeps
}

interface PendingToolCall {
  callId: string
  name: string
  input: unknown
  invalid?: string
}

export async function* query(input: QueryInput): AsyncGenerator<AgentEvent, void> {
  const { session, config, runtime, signal } = input
  const llm = input.deps?.llm ?? streamLLM
  const system = input.deps?.system ?? buildSystemPrompt(config, runtime.instructions)

  session.items.push(userMessage(newId("msg"), input.prompt))

  const declarations = selectDeclarations(runtime, input.deps?.toolNames)

  let lastMessage: AssistantMessage | undefined
  for (let step = 0; step < MAX_STEPS; step++) {
    if (signal.aborted) break

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
    lastMessage = message
    yield { type: "message-start", role: "assistant", messageId: message.id }

    const pendingCalls: PendingToolCall[] = []
    let streamError: unknown
    try {
      const stream = llm({
        provider: config.provider,
        model: config.model,
        endpointKind: config.endpointKind,
        baseUrl: baseUrl(config.provider, config.endpointKind),
        apiKey: requireApiKey(config.provider, config),
        system,
        messages: projectForModel(session, runtime.compactions),
        tools: declarations,
        ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
        maxOutputTokens: resolveMaxOutputTokens(config),
        signal,
      })
      for await (const event of stream) {
        applyStreamEvent(event, message, pendingCalls)
        const forwarded = forwardStreamEvent(event, message.id)
        if (forwarded !== undefined) yield forwarded
        if (event.type === "finish") {
          message.usage = event.usage
          session.totalUsage = addUsage(session.totalUsage, event.usage)
          message.stopReason = event.reason === "tool-calls" ? "tool-calls" : "end"
          yield { type: "step-usage", usage: event.usage }
        }
      }
    } catch (error) {
      streamError = error
    }

    if (streamError !== undefined) {
      const mapped = toZCodeError(streamError)
      if (mapped.code === "aborted" || signal.aborted) {
        finalizeMessage(session, message, "aborted")
        break
      }
      finalizeMessage(session, message, "error")
      yield { type: "error", error: mapped.toAgentError() }
      return
    }

    finalizeMessage(session, message, message.stopReason)

    if (pendingCalls.length === 0) break

    let interrupted = false
    for (const call of pendingCalls) {
      if (signal.aborted) {
        interrupted = true
        break
      }
      const result = yield* runToolCall(call, input)
      session.items.push(toolResultItem(call, result))
      yield { type: "tool-end", callId: call.callId, result }
      if (result.status === "aborted") {
        interrupted = true
        break
      }
    }
    if (interrupted || signal.aborted) break
  }

  if (lastMessage !== undefined) yield { type: "done", message: lastMessage }
}

async function* runToolCall(call: PendingToolCall, input: QueryInput): AsyncGenerator<AgentEvent, ToolResult> {
  const { runtime, signal, session } = input
  yield { type: "tool-start", callId: call.callId, name: call.name, input: call.input }

  if (call.invalid !== undefined) {
    return { status: "error", output: `invalid tool call: ${call.invalid}` }
  }
  const tool = runtime.registry.get(call.name)
  if (tool === undefined) {
    return { status: "error", output: `unknown tool: ${call.name}` }
  }
  const parsed = tool.parse(call.input)
  if (!parsed.ok) {
    return { status: "error", output: parsed.error }
  }

  const ctx: ToolContext = {
    cwd: session.cwd,
    signal,
    callId: call.callId,
    files: runtime.files,
    onProgress: () => {},
  }

  const request = tool.permission(parsed.value, ctx)
  if (request !== null) {
    const outcome = runtime.permissions.evaluate(request)
    if (outcome === "deny") {
      const message = runtime.permissions.isPlanMode() && runtime.permissions.isMutating(call.name)
        ? planModeDenyMessage(call.name)
        : `permission denied for ${call.name}`
      return { status: "denied", output: message }
    }
    if (outcome === "ask") {
      const decision = yield* askPermission(request)
      runtime.permissions.applyDecision(request, decision)
      if (decision === "deny") {
        return { status: "denied", output: `user denied ${call.name}` }
      }
    }
  }

  const chunks: string[] = []
  let notify: (() => void) | null = null
  const progressCtx: ToolContext = {
    ...ctx,
    onProgress: (chunk) => {
      chunks.push(chunk)
      const wake = notify
      notify = null
      wake?.()
    },
  }

  let settled = false
  let failure: unknown
  const execution = tool
    .execute(parsed.value, progressCtx)
    .catch((error: unknown) => {
      failure = error
      return undefined
    })
    .finally(() => {
      settled = true
      const wake = notify
      notify = null
      wake?.()
    })

  while (!settled || chunks.length > 0) {
    while (chunks.length > 0) {
      const chunk = chunks.shift()
      if (chunk !== undefined) yield { type: "tool-progress", callId: call.callId, chunk }
    }
    if (settled) break
    await new Promise<void>((resolve) => {
      notify = resolve
    })
  }

  const result = await execution
  if (failure !== undefined) {
    const mapped = toZCodeError(failure, "tool")
    if (mapped.code === "aborted") return { status: "aborted", output: "tool interrupted" }
    return { status: "error", output: mapped.message }
  }
  return result ?? { status: "error", output: `tool ${call.name} returned no result` }
}

function askPermission(request: PermissionRequest): AsyncGenerator<AgentEvent, PermissionDecision> {
  let resolve!: (decision: PermissionDecision) => void
  const decided = new Promise<PermissionDecision>((r) => {
    resolve = r
  })
  async function* generator(): AsyncGenerator<AgentEvent, PermissionDecision> {
    yield { type: "permission-ask", request, respond: (decision) => resolve(decision) }
    return await decided
  }
  return generator()
}

function applyStreamEvent(event: LLMStreamEvent, message: AssistantMessage, calls: PendingToolCall[]): void {
  switch (event.type) {
    case "text-delta":
      appendText(message, "text", event.text)
      break
    case "reasoning-delta":
      appendText(message, "reasoning", event.text)
      break
    case "tool-call":
      message.parts.push({ type: "tool-call", callId: event.callId, name: event.name, input: event.input })
      calls.push({
        callId: event.callId,
        name: event.name,
        input: event.input,
        ...(event.invalid === undefined ? {} : { invalid: event.invalid }),
      })
      break
    case "finish":
      break
  }
}

function forwardStreamEvent(event: LLMStreamEvent, messageId: string): AgentEvent | undefined {
  if (event.type === "text-delta") return { type: "text-delta", messageId, delta: event.text }
  if (event.type === "reasoning-delta") return { type: "reasoning-delta", messageId, delta: event.text }
  return undefined
}

function finalizeMessage(session: Session, message: AssistantMessage, stopReason: AssistantMessage["stopReason"]): void {
  message.stopReason = stopReason
  if (message.parts.length > 0) session.items.push(message)
}

function toolResultItem(call: PendingToolCall, result: ToolResult): ToolResultItem {
  return { type: "tool-result", callId: call.callId, name: call.name, result }
}

function appendText(message: AssistantMessage, type: "text" | "reasoning", text: string): void {
  const last = message.parts[message.parts.length - 1]
  if (last !== undefined && last.type === type) {
    last.text += text
    return
  }
  message.parts.push({ type, text } as AssistantPart)
}

function selectDeclarations(runtime: AgentRuntime, only: string[] | undefined) {
  const all = runtime.registry.declarations()
  if (only === undefined) return all
  const allowed = new Set(only)
  return all.filter((decl) => allowed.has(decl.name))
}

export function resolveMaxOutputTokens(config: ResolvedConfig): number {
  const info = modelInfo(config, config.model)
  const cap = info?.maxOutput ?? DEFAULT_MAX_OUTPUT_TOKENS
  return Math.min(config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS, cap)
}
