import os from "node:os"
import type { AgentEvent } from "@/agent/events"
import { buildSessionContext, withSessionContext } from "@/agent/session-context"
import { buildSystemPrompt } from "@/agent/system"
import { projectForModel, recordInvokedSkill } from "@/agent/compact"
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
import { mapPool } from "@/util/pool"
import { newId } from "@/util/id"

const DEFAULT_MAX_OUTPUT_TOKENS = 32_768
const MAX_TOOL_CONCURRENCY = 4

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
  const llm = input.deps?.llm ?? runtime.llm ?? streamLLM
  const system = input.deps?.system ?? buildSystemPrompt()
  const sessionContext = buildSessionContext({
    cwd: session.cwd,
    platform: process.platform,
    platformRelease: os.release(),
    date: new Date().toDateString(),
    skillCatalogBudgetChars: config.skills.catalogBudgetChars,
    instructions: runtime.instructions,
    planMode: runtime.permissions.isPlanMode(),
    skills: runtime.skills,
    activePaths: runtime.files.touchedPaths(),
  })

  session.items.push(userMessage(newId("msg"), input.prompt))

  const declarations = selectDeclarations(runtime, input.deps?.toolNames)

  let lastMessage: AssistantMessage | undefined
  while (true) {
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
        messages: withSessionContext(
          projectForModel(session, runtime.compactions, session.invokedSkills),
          sessionContext,
        ),
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

    const interrupted = yield* runToolPhase(pendingCalls, input, message.id)
    if (interrupted || signal.aborted) break
  }

  if (lastMessage !== undefined) yield { type: "done", message: lastMessage }
}

interface ResolvedCall {
  call: PendingToolCall
  tool: ReturnType<AgentRuntime["registry"]["get"]>
  value: unknown
}

async function* runToolPhase(
  pendingCalls: PendingToolCall[],
  input: QueryInput,
  assistantId: string,
): AsyncGenerator<AgentEvent, boolean> {
  const { runtime, signal, session } = input

  for (const call of pendingCalls) {
    yield { type: "tool-start", callId: call.callId, name: call.name, input: call.input }
  }

  const results = new Map<string, ToolResult>()
  const toRun: ResolvedCall[] = []

  // Resolve permissions sequentially so at most one approval dialog is open at a time.
  for (const call of pendingCalls) {
    const prepared = prepareCall(call, input)
    if (prepared.kind === "result") {
      results.set(call.callId, prepared.result)
      continue
    }
    const request = prepared.tool?.permission(prepared.value, prepared.ctx) ?? null
    if (request !== null) {
      const outcome = runtime.permissions.evaluate(request)
      if (outcome === "deny") {
        results.set(call.callId, {
          status: "denied",
          output:
            runtime.permissions.isPlanMode() && runtime.permissions.isMutating(call.name)
              ? planModeDenyMessage(call.name)
              : `permission denied for ${call.name}`,
        })
        continue
      }
      if (outcome === "ask") {
        const decision = yield* askPermission(request)
        runtime.permissions.applyDecision(request, decision)
        if (decision === "deny") {
          results.set(call.callId, { status: "denied", output: `user denied ${call.name}` })
          continue
        }
      }
    }
    toRun.push({ call: call, tool: prepared.tool, value: prepared.value })
  }

  // Execute approved calls concurrently, streaming progress through a shared queue.
  const queue: AgentEvent[] = []
  let notify: (() => void) | null = null
  const wake = (): void => {
    const fn = notify
    notify = null
    fn?.()
  }
  const push = (event: AgentEvent): void => {
    queue.push(event)
    wake()
  }

  let done = false
  const runner = mapPool(toRun, MAX_TOOL_CONCURRENCY, async (entry) => {
    const result = await executeOne(entry, session.cwd, session.id, signal, runtime, (chunk) =>
      push({ type: "tool-progress", callId: entry.call.callId, chunk }),
    )
    results.set(entry.call.callId, result)
  })
    .catch(() => {})
    .finally(() => {
      done = true
      wake()
    })

  while (!done || queue.length > 0) {
    while (queue.length > 0) {
      const event = queue.shift()
      if (event !== undefined) yield event
    }
    if (done) break
    await new Promise<void>((resolve) => {
      notify = resolve
    })
  }
  await runner

  // Emit tool-end and record results in call order.
  let interrupted = signal.aborted
  for (const call of pendingCalls) {
    const result = results.get(call.callId) ?? { status: "error", output: `tool ${call.name} produced no result` }
    session.items.push(toolResultItem(call, result))
    const invoked = readInvokedSkill(result.metadata)
    if (invoked !== null) recordInvokedSkill(session, { ...invoked, itemId: assistantId })
    yield { type: "tool-end", callId: call.callId, result }
    if (result.status === "aborted") interrupted = true
  }
  return interrupted
}

function readInvokedSkill(metadata: Record<string, unknown> | undefined): { name: string; body: string } | null {
  const value = metadata?.["invokedSkill"]
  if (value === null || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  const name = record["name"]
  const body = record["body"]
  if (typeof name === "string" && typeof body === "string") return { name, body }
  return null
}

type PreparedCall =
  | { kind: "result"; result: ToolResult }
  | { kind: "run"; tool: ResolvedCall["tool"]; value: unknown; ctx: ToolContext }

function prepareCall(call: PendingToolCall, input: QueryInput): PreparedCall {
  const { runtime, signal, session } = input
  if (call.invalid !== undefined) {
    return { kind: "result", result: { status: "error", output: `invalid tool call: ${call.invalid}` } }
  }
  const tool = runtime.registry.get(call.name)
  if (tool === undefined) {
    return { kind: "result", result: { status: "error", output: `unknown tool: ${call.name}` } }
  }
  const parsed = tool.parse(call.input)
  if (!parsed.ok) {
    return { kind: "result", result: { status: "error", output: parsed.error } }
  }
  const ctx: ToolContext = {
    cwd: session.cwd,
    signal,
    callId: call.callId,
    sessionId: session.id,
    files: runtime.files,
    onProgress: () => {},
  }
  return { kind: "run", tool, value: parsed.value, ctx }
}

async function executeOne(
  entry: ResolvedCall,
  cwd: string,
  sessionId: string,
  signal: AbortSignal,
  runtime: AgentRuntime,
  onProgress: (chunk: string) => void,
): Promise<ToolResult> {
  const tool = entry.tool
  if (tool === undefined) return { status: "error", output: `unknown tool: ${entry.call.name}` }
  const ctx: ToolContext = { cwd, signal, callId: entry.call.callId, sessionId, files: runtime.files, onProgress }
  try {
    const result = await tool.execute(entry.value, ctx)
    return result
  } catch (error) {
    const mapped = toZCodeError(error, "tool")
    if (mapped.code === "aborted") return { status: "aborted", output: "tool interrupted" }
    return { status: "error", output: mapped.message }
  }
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
