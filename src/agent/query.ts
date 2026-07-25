import os from "node:os"
import type { AgentEvent } from "@/agent/events"
import { buildSessionContext, withSessionContext } from "@/agent/session-context"
import { buildSystemPrompt } from "@/agent/system"
import { contextWindow, lastPromptTokens, projectForModel, recordInvokedSkill } from "@/agent/compact"
import { compressForModel, type CompressionReport } from "@/agent/compress"
import { spillToolResult } from "@/agent/spill"
import {
  budgetRefusalOutput,
  costEnforceable,
  estimateSessionCost,
  evaluateBudget,
  unpricedModelWarning,
  type BudgetLimits,
  type BudgetLimitKind,
} from "@/agent/budget"
import type { AgentRuntime } from "@/agent/runtime"
import type { ResolvedConfig } from "@/config/config"
import { modelInfo } from "@/config/config"
import { baseUrl, requireApiKey } from "@/llm/providers"
import { streamLLM } from "@/llm/stream"
import type { LLMStreamEvent, LLMStreamFn, LLMToolDecl } from "@/llm/types"
import { isDeferredTool, projectDeclarations } from "@/tools/deferred"
import {
  EMPTY_USAGE,
  userMessage,
  type AssistantMessage,
  type AssistantPart,
  type ChatItem,
  type ModelUsage,
  type ToolResultItem,
} from "@/session/messages"
import type { Session } from "@/session/session"
import { recordUsage } from "@/session/session"
import type { ToolResult } from "@/tools/types"
import type { AnyTool, ToolContext } from "@/tools/registry"
import type { MemorySession } from "@/memory/recall"
import type { PermissionDecision, PermissionRequest } from "@/permissions/types"
import { planModeDenyMessage } from "@/permissions/policy"
import { classifyAction } from "@/permissions/auto-classifier"
import { complete as defaultComplete } from "@/llm/complete"
import { toZCodeError } from "@/util/errors"
import { mapPool } from "@/util/pool"
import { newId } from "@/util/id"

const DEFAULT_MAX_OUTPUT_TOKENS = 32_768
const MAX_TOOL_CONCURRENCY = 4
const AUDIT_SUBJECT_MAX_CHARS = 200

export interface QueryDeps {
  llm?: LLMStreamFn
  system?: string
  toolNames?: string[]
  /** Cross-turn memory recall state. Subagents never receive one, so they never recall. */
  memory?: MemorySession
  /** Persists model usage that is not carried by an assistant message. */
  persistUsage?: (usage: ModelUsage) => void
  /** Session that owns usage incurred by this query. Child queries use their parent session. */
  usageSession?: Session
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

/** Events produced off the main generator (tool progress, early starts) awaiting a yield slot. */
interface EventQueue {
  push: (event: AgentEvent) => void
  takeAll: () => AgentEvent[]
  size: () => number
  wait: () => Promise<void>
  wake: () => void
}

function createEventQueue(): EventQueue {
  const queue: AgentEvent[] = []
  let notify: (() => void) | null = null
  const wake = (): void => {
    const fn = notify
    notify = null
    fn?.()
  }
  return {
    push: (event) => {
      queue.push(event)
      wake()
    },
    takeAll: () => queue.splice(0, queue.length),
    size: () => queue.length,
    wait: () =>
      new Promise<void>((resolve) => {
        notify = resolve
      }),
    wake,
  }
}

/**
 * Tool calls started mid-stream, in call order. A stored run never rejects — `executeOne` maps
 * every failure to a result — so draining is always safe. `active` counts only unsettled runs.
 */
interface EarlyExecutions {
  runs: Map<string, Promise<ToolResult>>
  active: () => number
  track: (callId: string, run: Promise<ToolResult>) => void
}

function createEarlyExecutions(): EarlyExecutions {
  const runs = new Map<string, Promise<ToolResult>>()
  let active = 0
  return {
    runs,
    active: () => active,
    track: (callId, run) => {
      active += 1
      runs.set(
        callId,
        run.finally(() => {
          active -= 1
        }),
      )
    },
  }
}

export async function* query(input: QueryInput): AsyncGenerator<AgentEvent, void> {
  const { session, config, runtime, signal } = input
  const usageSession = input.deps?.usageSession ?? session
  const llm = input.deps?.llm ?? runtime.llm ?? streamLLM
  const system = input.deps?.system ?? buildSystemPrompt()
  const memory = input.deps?.memory
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
    memorySection: memory === undefined ? "" : await memory.promptSection(),
  })

  session.items.push(userMessage(newId("msg"), input.prompt))

  // Recalled memories, re-appended every iteration so an injection lasts the rest of the turn.
  const turnRecalls: string[] = []
  const limits = resolveLimits(config)
  /** Warned-about limits, so each fires at most once per invocation however its total moves. */
  const warned = new Set<BudgetLimitKind>()
  let turnCount = 0
  const unpricedModel = [
    config.model,
    ...Object.keys(usageSession.usageByModel),
    ...(runtime.permissions.isAutoMode()
      ? [config.autoMode.gateModel ?? config.model, config.autoMode.judgeModel ?? config.model]
      : []),
  ].find((model) => !costEnforceable(config, model))
  if (limits.maxCostUsd !== undefined && unpricedModel !== undefined) {
    // Cost cannot be enforced, so no cost warning will ever fire; disclose that once instead.
    warned.add("cost")
    yield { type: "budget-warning", reason: unpricedModelWarning(unpricedModel) }
  }

  let lastMessage: AssistantMessage | undefined
  let memoryStarted = false
  while (true) {
    if (signal.aborted) break
    const requestBudget = evaluateBudget(limits, {
      turns: turnCount,
      costUsd: estimateSessionCost(config, usageSession.usageByModel),
    })
    if (requestBudget.kind === "exceeded") {
      yield { type: "budget-exceeded", reason: requestBudget.reason }
      break
    }
    if (requestBudget.kind === "warn" && !warned.has(requestBudget.limit)) {
      warned.add(requestBudget.limit)
      yield { type: "budget-warning", reason: requestBudget.reason }
    }
    if (!memoryStarted) {
      memoryStarted = true
      memory?.beginTurn(input.prompt, signal, (usage) => recordSideUsage(input, usage))
    }

    const recall = memory?.pollInjection() ?? null
    if (recall !== null) {
      turnRecalls.push(recall.text)
      yield { type: "memory-recall", names: recall.names }
    }

    const projected = projectForModel(session, runtime.compactions, session.invokedSkills)
    const compressed = compressProjection(input, projected)
    if (compressed !== null && rewroteAnything(compressed.report)) {
      yield { type: "compression", ...compressed.report }
    }
    const withContext = withSessionContext(compressed?.items ?? projected, sessionContext)
    const messages = [...withContext, ...turnRecalls.map((text) => userMessage(newId("msg"), text))]

    // Rebuilt per request: a toolsearch activation takes effect on the very next iteration.
    const declarations = selectDeclarations(runtime, config, input.deps?.toolNames)

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
    const events = createEventQueue()
    const early = createEarlyExecutions()

    let streamError: unknown
    try {
      const stream = llm({
        provider: config.provider,
        model: config.model,
        endpointKind: config.endpointKind,
        baseUrl: baseUrl(config.provider, config.endpointKind),
        apiKey: requireApiKey(config.provider, config),
        system,
        messages,
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
          const modelUsage = { model: message.model, usage: event.usage }
          recordUsage(usageSession, modelUsage.model, modelUsage.usage)
          if (usageSession !== session) input.deps?.persistUsage?.(modelUsage)
          message.stopReason = event.reason === "tool-calls" ? "tool-calls" : "end"
          yield { type: "step-usage", usage: event.usage }
        }
        if (event.type === "tool-call" && config.earlyToolExecution) {
          const call = pendingCalls[pendingCalls.length - 1]
          if (call !== undefined) startEarly(call, input, early, events, limits, turnCount)
        }
        // Drain without blocking so an early tool's start and progress reach the UI mid-stream.
        for (const queued of events.takeAll()) yield queued
      }
    } catch (error) {
      streamError = error
    }

    for (const queued of events.takeAll()) yield queued

    if (streamError !== undefined) {
      const mapped = toZCodeError(streamError)
      finalizeMessage(session, message, mapped.code === "aborted" || signal.aborted ? "aborted" : "error")
      // Started work is awaited, never abandoned, so no promise dangles and every started call pairs.
      yield* settleWithoutToolPhase(pendingCalls, early, input)
      if (mapped.code === "aborted" || signal.aborted) break
      yield { type: "error", error: mapped.toAgentError() }
      return
    }

    finalizeMessage(session, message, message.stopReason)

    if (pendingCalls.length === 0) break

    // Budget gate. It sits before runToolPhase, so nothing is in flight and no approval dialog is
    // open when it trips; every refused call still gets a paired result so history stays valid.
    turnCount += 1
    const verdict = evaluateBudget(limits, {
      turns: turnCount,
      // An unpriced model estimates to 0, so a cost cap simply never fires — disclosed once above.
      costUsd: estimateSessionCost(config, usageSession.usageByModel),
    })
    if (verdict.kind === "exceeded") {
      // Calls already running keep their real results; only unstarted calls are refused. Either
      // way every pending call is paired, so the stop leaves valid, continuable history.
      yield* settleWithoutToolPhase(pendingCalls, early, input, () => ({
        status: "denied",
        output: budgetRefusalOutput(verdict.reason),
      }))
      yield { type: "budget-exceeded", reason: verdict.reason }
      break
    }
    if (verdict.kind === "warn" && !warned.has(verdict.limit)) {
      warned.add(verdict.limit)
      yield { type: "budget-warning", reason: verdict.reason }
    }

    const interrupted = yield* runToolPhase(pendingCalls, input, message.id, early, events)
    if (interrupted || signal.aborted) break
  }

  if (lastMessage !== undefined) yield { type: "done", message: lastMessage }
}

/** Tier 1-3 rewrites over the projected messages, or null when compression is off. */
function compressProjection(
  input: QueryInput,
  items: ChatItem[],
): { items: ChatItem[]; report: CompressionReport } | null {
  const { session, config, runtime } = input
  if (!config.compression.enabled) return null
  return compressForModel(items, {
    usedTokens: lastPromptTokens(session, runtime.compactions),
    window: contextWindow(config),
    now: Date.now(),
    keepRecent: config.compression.keepRecentResults,
    idleMs: config.compression.idleMs,
  })
}

/**
 * Start a tool the moment its arguments arrive, if and only if both gates pass: the tool is
 * statically marked concurrency-safe, and its permission verdict is decidable right now without a
 * human. An `ask` outcome always defers to `runToolPhase`, so early execution can never skip,
 * queue, or reorder an approval dialog.
 */
function startEarly(
  call: PendingToolCall,
  input: QueryInput,
  early: EarlyExecutions,
  events: EventQueue,
  limits: BudgetLimits,
  turnCount: number,
): void {
  const { runtime, session, config, signal } = input
  if (early.active() >= MAX_TOOL_CONCURRENCY) return
  // Cheapest gate first: most calls are not concurrency-safe, and this skips parsing them twice.
  if (runtime.registry.get(call.name)?.concurrencySafe !== true) return

  const prepared = prepareCall(call, input)
  if (prepared.kind !== "run") return
  if (!canStartEarly(prepared, runtime)) return

  // A call the budget is about to refuse must not start. The turn-count case is exact here; the
  // cost case can only trip on this step's own usage, which is unknowable mid-stream — that one is
  // handled by draining at the gate instead.
  const projected = evaluateBudget(limits, {
    turns: turnCount + 1,
    costUsd: estimateSessionCost(config, input.deps?.usageSession?.usageByModel ?? session.usageByModel),
  })
  if (projected.kind === "exceeded") return

  events.push({ type: "tool-start", callId: call.callId, name: call.name, input: call.input })
  const entry: ResolvedCall = { call, tool: prepared.tool, value: prepared.value }
  early.track(
    call.callId,
    executeOne(
      entry,
      session.cwd,
      session.id,
      input.deps?.usageSession ?? session,
      input.deps?.persistUsage,
      signal,
      runtime,
      (chunk) => events.push({ type: "tool-progress", callId: call.callId, chunk }),
    ),
  )
}

/** Sync, dialog-free early-start decision. */
function canStartEarly(prepared: Extract<PreparedCall, { kind: "run" }>, runtime: AgentRuntime): boolean {
  const tool = prepared.tool
  const request = tool.permission(prepared.value, prepared.ctx)
  if (request === null) return true
  if (decideHeadlessPermission(runtime, request) === "deny") return false
  return runtime.permissions.evaluate(request) === "allow"
}

async function settleAll(early: EarlyExecutions): Promise<Map<string, ToolResult>> {
  const settled = new Map<string, ToolResult>()
  for (const [callId, run] of early.runs) settled.set(callId, await run)
  return settled
}

/**
 * Pair pending calls with results on a loop exit that skips the tool phase. Early-started calls
 * keep their real result; `refuse` decides what an unstarted call gets, so the one place that knows
 * how a started call is recorded also governs how an unstarted one is closed out.
 */
async function* settleWithoutToolPhase(
  pendingCalls: PendingToolCall[],
  early: EarlyExecutions,
  input: QueryInput,
  refuse?: () => ToolResult,
  resolved: ReadonlyMap<string, ToolResult> = new Map(),
): AsyncGenerator<AgentEvent, void> {
  const settled = await settleAll(early)
  for (const call of pendingCalls) {
    const executed = settled.get(call.callId) ?? resolved.get(call.callId) ?? refuse?.()
    if (executed === undefined) continue
    const stored = await spillToolResult(input.session, call.callId, executed, input.config)
    input.session.items.push(toolResultItem(call, stored))
    yield { type: "tool-end", callId: call.callId, result: stored }
  }
}

function resolveLimits(config: ResolvedConfig): BudgetLimits {
  return {
    ...(config.budget.maxTurns === undefined ? {} : { maxTurns: config.budget.maxTurns }),
    ...(config.budget.maxCostUsd === undefined ? {} : { maxCostUsd: config.budget.maxCostUsd }),
    warnAt: config.budget.warnAt,
  }
}

function rewroteAnything(report: CompressionReport): boolean {
  return report.budgeted + report.snipped + report.cleared > 0
}

interface ResolvedCall {
  call: PendingToolCall
  tool: AnyTool
  value: unknown
}

async function* runToolPhase(
  pendingCalls: PendingToolCall[],
  input: QueryInput,
  assistantId: string,
  early: EarlyExecutions,
  events: EventQueue,
): AsyncGenerator<AgentEvent, boolean> {
  const { runtime, signal, session, config } = input

  for (const call of pendingCalls) {
    if (early.runs.has(call.callId)) continue
    yield { type: "tool-start", callId: call.callId, name: call.name, input: call.input }
  }

  const results = new Map<string, ToolResult>()
  const toRun: ResolvedCall[] = []

  // Resolve permissions sequentially so at most one approval dialog is open at a time. A call that
  // started early is skipped entirely: it was already permitted, and re-asking would double-prompt.
  for (const call of pendingCalls) {
    if (early.runs.has(call.callId)) continue
    const prepared = prepareCall(call, input)
    if (prepared.kind === "result") {
      results.set(call.callId, prepared.result)
      continue
    }
    const request = prepared.tool?.permission(prepared.value, prepared.ctx) ?? null
    if (request !== null) {
      const headlessDecision = decideHeadlessPermission(runtime, request)
      if (headlessDecision === "deny") {
        results.set(call.callId, { status: "denied", output: `permission denied for ${call.name}` })
        continue
      }
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
        if (runtime.permissions.isAutoMode()) {
          const auto = yield* classifyPermission(request, call, prepared.value, input)
          if (signal.aborted || auto.kind === "aborted") {
            yield* settleWithoutToolPhase(
              pendingCalls,
              early,
              input,
              () => ({
                status: "aborted",
                output: "tool interrupted",
              }),
              results,
            )
            return true
          }
          if (auto.kind === "block") {
            results.set(call.callId, { status: "denied", output: `auto mode blocked this action: ${auto.reason}` })
            continue
          }
          // "allow" falls through to execution; "handback" falls through to the human dialog.
          if (auto.kind === "allow") {
            toRun.push({ call, tool: prepared.tool, value: prepared.value })
            continue
          }
        }
        if (headlessDecision === "allow-once") {
          if (runtime.permissions.isAutoMode()) {
            results.set(call.callId, { status: "denied", output: `permission denied for ${call.name}` })
            continue
          }
          toRun.push({ call, tool: prepared.tool, value: prepared.value })
          continue
        }
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

  // Execute approved calls concurrently, streaming progress through the shared queue. Early runs
  // still in flight hold pool slots. The floor of one worker means a fully saturated early batch
  // can overshoot the limit by one rather than stall a deferred call behind a slow read.
  let done = false
  const concurrency = Math.max(1, MAX_TOOL_CONCURRENCY - early.active())
  const runner = mapPool(toRun, concurrency, async (entry) => {
    const result = await executeOne(
      entry,
      session.cwd,
      session.id,
      input.deps?.usageSession ?? session,
      input.deps?.persistUsage,
      signal,
      runtime,
      (chunk) => events.push({ type: "tool-progress", callId: entry.call.callId, chunk }),
    )
    results.set(entry.call.callId, result)
  })
    .catch(() => {})
    .finally(() => {
      done = true
      events.wake()
    })

  while (!done || events.size() > 0) {
    for (const event of events.takeAll()) yield event
    if (done) break
    await events.wait()
  }
  await runner
  for (const event of events.takeAll()) yield event

  // Emit tool-end and record results in call order, so completion order never leaks into history.
  let interrupted = signal.aborted
  for (const call of pendingCalls) {
    const earlyRun = early.runs.get(call.callId)
    const executed =
      earlyRun !== undefined
        ? await earlyRun
        : (results.get(call.callId) ?? { status: "error", output: `tool ${call.name} produced no result` })
    const result = await spillToolResult(session, call.callId, executed, config)
    session.items.push(toolResultItem(call, result))
    const invoked = readInvokedSkill(result.metadata)
    if (invoked !== null) recordInvokedSkill(session, { ...invoked, itemId: assistantId })
    yield { type: "tool-end", callId: call.callId, result }
    if (result.status === "aborted") interrupted = true
  }
  return interrupted
}

function decideHeadlessPermission(
  runtime: AgentRuntime,
  request: PermissionRequest,
): Exclude<PermissionDecision, "allow-session"> | undefined {
  const decision = runtime.decidePermission?.(request)
  if (decision === "allow-session") {
    throw new Error("a headless permission boundary cannot grant the parent session")
  }
  return decision
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
  { kind: "result"; result: ToolResult } | { kind: "run"; tool: AnyTool; value: unknown; ctx: ToolContext }

function prepareCall(call: PendingToolCall, input: QueryInput): PreparedCall {
  const { runtime, signal, session, config } = input
  if (call.invalid !== undefined) {
    return { kind: "result", result: { status: "error", output: `invalid tool call: ${call.invalid}` } }
  }
  const tool = runtime.registry.get(call.name)
  if (tool === undefined) {
    return { kind: "result", result: { status: "error", output: `unknown tool: ${call.name}` } }
  }
  // Fail closed: a deferred tool's name is visible in the toolsearch description, so the model can
  // guess a call. Without its schema the arguments are unvalidated, so refuse rather than execute.
  if (isDeferredTool(tool, config) && !runtime.deferred.activated.has(call.name)) {
    return {
      kind: "result",
      result: {
        status: "error",
        output: `tool ${call.name} is deferred — call toolsearch to load its schema first`,
      },
    }
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
    usageSession: input.deps?.usageSession ?? session,
    ...(input.deps?.persistUsage === undefined ? {} : { persistUsage: input.deps.persistUsage }),
    files: runtime.files,
    onProgress: () => {},
  }
  return { kind: "run", tool, value: parsed.value, ctx }
}

async function executeOne(
  entry: ResolvedCall,
  cwd: string,
  sessionId: string,
  usageSession: Session,
  persistUsage: ((usage: ModelUsage) => void) | undefined,
  signal: AbortSignal,
  runtime: AgentRuntime,
  onProgress: (chunk: string) => void,
): Promise<ToolResult> {
  const tool = entry.tool
  const ctx: ToolContext = {
    cwd,
    signal,
    callId: entry.call.callId,
    sessionId,
    usageSession,
    ...(persistUsage === undefined ? {} : { persistUsage }),
    files: runtime.files,
    onProgress,
  }
  try {
    return await tool.execute(entry.value, ctx)
  } catch (error) {
    const mapped = toZCodeError(error, "tool")
    if (mapped.code === "aborted") return { status: "aborted", output: "tool interrupted" }
    return { status: "error", output: mapped.message }
  }
}

type AutoOutcome = { kind: "allow" } | { kind: "block"; reason: string } | { kind: "handback" } | { kind: "aborted" }

/**
 * The auto-mode step, at the one place an `"ask"` outcome is consumed. Reached only for calls that
 * would otherwise have stopped for a human, so the static deny floor and every configured allow are
 * already settled. A classifier that is unreachable, or a denial limit that has tripped, hands back
 * to the dialog — never to a silent allow.
 */
async function* classifyPermission(
  request: PermissionRequest,
  call: PendingToolCall,
  value: unknown,
  input: QueryInput,
): AsyncGenerator<AgentEvent, AutoOutcome> {
  const { runtime, config, session, signal } = input
  // The budget is spent: stop classifying and give the human back the decision.
  if (runtime.permissions.isAutoDenialLimitReached()) {
    yield { type: "auto-handoff", reason: "auto mode hit its denial limit — back to manual approval" }
    return { kind: "handback" }
  }

  const complete = runtime.complete ?? defaultComplete
  const gateModel = config.autoMode.gateModel ?? config.model
  const judgeModel = config.autoMode.judgeModel ?? config.model
  const instructions = instructionsText(runtime)

  const verdict = await classifyAction({
    complete,
    target: {
      provider: config.provider,
      endpointKind: config.endpointKind,
      baseUrl: baseUrl(config.provider, config.endpointKind),
      apiKey: requireApiKey(config.provider, config),
    },
    gateModel,
    judgeModel,
    items: session.items,
    pending: { tool: call.name, input: classifierInput(call, value, runtime) },
    ...(instructions === "" ? {} : { instructions }),
    signal,
    onUsage: (usage) => recordSideUsage(input, usage),
  })

  if (signal.aborted) return { kind: "aborted" }

  yield {
    type: "auto-verdict",
    callId: call.callId,
    tool: call.name,
    subject: request.subject.slice(0, AUDIT_SUBJECT_MAX_CHARS),
    verdict: verdict.kind,
    stage: verdict.stage,
    reason: verdict.kind === "allow" ? "" : verdict.reason,
    model: verdict.stage === 1 ? gateModel : judgeModel,
  }

  if (verdict.kind === "unavailable") return { kind: "handback" }
  if (verdict.kind === "allow") {
    runtime.permissions.noteAutoAllow()
    return { kind: "allow" }
  }

  runtime.permissions.noteAutoDenial()
  return { kind: "block", reason: verdict.reason }
}

function classifierInput(call: PendingToolCall, value: unknown, runtime: AgentRuntime): unknown {
  if (call.name !== "skill" || typeof value !== "object" || value === null) return value
  const name = Reflect.get(value, "name")
  if (typeof name !== "string") return value
  const skill = runtime.skills.find((candidate) => candidate.name === name)
  if (skill === undefined) return value
  return {
    invocation: value,
    resolvedSkill: {
      context: skill.context,
      allowedTools: skill.allowedTools ?? [],
    },
  }
}

function recordSideUsage(input: QueryInput, modelUsage: ModelUsage): void {
  recordUsage(input.deps?.usageSession ?? input.session, modelUsage.model, modelUsage.usage)
  input.deps?.persistUsage?.(modelUsage)
}

function instructionsText(runtime: AgentRuntime): string {
  return runtime.instructions.map((file) => `# ${file.path}\n${file.content}`).join("\n\n")
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

/** Deferral is applied before the `toolNames` allowlist, so an allowlist cannot unhide a tool. */
function selectDeclarations(runtime: AgentRuntime, config: ResolvedConfig, only: string[] | undefined): LLMToolDecl[] {
  const all = projectDeclarations(runtime.registry, config, runtime.deferred)
  if (only === undefined) return all
  const allowed = new Set(only)
  return all.filter((decl) => allowed.has(decl.name))
}

export function resolveMaxOutputTokens(config: ResolvedConfig): number {
  const info = modelInfo(config, config.model)
  const cap = info?.maxOutput ?? DEFAULT_MAX_OUTPUT_TOKENS
  return Math.min(config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS, cap)
}
