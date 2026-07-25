import type { AssistantMessage, ChatItem, ToolResultItem } from "@/session/messages"

export interface CompressionReport {
  /** Tier 1: oversized results shrunk to head+tail. */
  budgeted: number
  /** Tier 2: stale or duplicate results replaced by the snip placeholder. */
  snipped: number
  /** Tier 3: results cleared after an idle gap. */
  cleared: number
  /** Output characters removed across all tiers. */
  savedChars: number
}

export interface CompressionOptions {
  /** Prompt tokens of the most recent request, from `lastPromptTokens`. */
  usedTokens: number
  /** Model context window, from `contextWindow`. */
  window: number
  /** Injected clock, so idle detection is testable. */
  now: number
  /** Newest tool results kept verbatim by tiers 2 and 3. */
  keepRecent: number
  /** Gap after which a prefix is assumed cold and old results are cleared. */
  idleMs: number
}

const BUDGET_THRESHOLD = 0.5
const BUDGET_AGGRESSIVE_THRESHOLD = 0.7
const BUDGET_CHARS = 30_000
const BUDGET_AGGRESSIVE_CHARS = 15_000
const BUDGET_MARKER_RESERVE = 80
const SNIP_THRESHOLD = 0.6
const SNIP_HOT_OVERRIDE = 0.75

export const SNIP_PLACEHOLDER = "[Content snipped - re-read if needed]"
export const CLEARED_PLACEHOLDER = "[Old result cleared]"
const PLACEHOLDERS = new Set([SNIP_PLACEHOLDER, CLEARED_PLACEHOLDER])

/**
 * Builtin tools whose output the model can recover by calling them again. MCP tool output is never
 * snipped because it is not reproducible from the conversation. New re-readable builtins must be
 * added here by hand.
 */
const SNIPPABLE_TOOLS = new Set(["read", "grep", "glob", "bash"])

/**
 * Shrink tool-result outputs for one request. Pure: user and assistant items pass through by
 * reference, item count and order never change, and neither the input array nor its items are
 * mutated.
 */
export function compressForModel(
  items: ChatItem[],
  options: CompressionOptions,
): { items: ChatItem[]; report: CompressionReport } {
  const report: CompressionReport = { budgeted: 0, snipped: 0, cleared: 0, savedChars: 0 }
  const utilization = options.usedTokens / options.window

  let current = applyTier(items, budgetRewrites(items, utilization), "budgeted", report)
  if (snipAllowed(items, utilization, options)) {
    current = applyTier(current, snipRewrites(current, options.keepRecent), "snipped", report)
  }
  if (isIdle(items, options)) {
    current = applyTier(current, clearRewrites(current, options.keepRecent), "cleared", report)
  }
  return { items: current, report }
}

interface ResultEntry {
  index: number
  item: ToolResultItem
}

interface Rewrite extends ResultEntry {
  output: string
}

function applyTier(
  items: ChatItem[],
  rewrites: Rewrite[],
  tier: "budgeted" | "snipped" | "cleared",
  report: CompressionReport,
): ChatItem[] {
  if (rewrites.length === 0) return items
  const next = items.slice()
  for (const rewrite of rewrites) {
    report[tier] += 1
    report.savedChars += rewrite.item.result.output.length - rewrite.output.length
    next[rewrite.index] = { ...rewrite.item, result: { ...rewrite.item.result, output: rewrite.output } }
  }
  return next
}

function toolResults(items: ChatItem[]): ResultEntry[] {
  const entries: ResultEntry[] = []
  items.forEach((item, index) => {
    if (item.type === "tool-result") entries.push({ index, item })
  })
  return entries
}

function budgetRewrites(items: ChatItem[], utilization: number): Rewrite[] {
  if (utilization < BUDGET_THRESHOLD) return []
  const budget = utilization > BUDGET_AGGRESSIVE_THRESHOLD ? BUDGET_AGGRESSIVE_CHARS : BUDGET_CHARS
  return toolResults(items)
    .filter((entry) => entry.item.result.output.length > budget)
    .map((entry) => ({ ...entry, output: headTail(entry.item.result.output, budget) }))
}

function headTail(output: string, budget: number): string {
  const keep = Math.floor((budget - BUDGET_MARKER_RESERVE) / 2)
  const dropped = output.length - keep * 2
  return `${output.slice(0, keep)}\n[... budgeted: ${dropped} chars truncated ...]\n${output.slice(-keep)}`
}

function snipAllowed(items: ChatItem[], utilization: number, options: CompressionOptions): boolean {
  if (utilization < SNIP_THRESHOLD) return false
  if (utilization >= SNIP_HOT_OVERRIDE) return true
  return !isCacheHot(items, options)
}

function snipRewrites(items: ChatItem[], keepRecent: number): Rewrite[] {
  const candidates = toolResults(items).filter(
    (entry) => SNIPPABLE_TOOLS.has(entry.item.name) && replaceable(entry.item.result.output, SNIP_PLACEHOLDER),
  )
  const doomed = new Set(candidates.slice(0, Math.max(0, candidates.length - keepRecent)).map((entry) => entry.index))
  for (const index of supersededReads(items, candidates)) doomed.add(index)
  return candidates
    .filter((entry) => doomed.has(entry.index))
    .map((entry) => ({ ...entry, output: SNIP_PLACEHOLDER }))
}

/** Indexes of read results for a path that a later read of the same path already refreshed. */
function supersededReads(items: ChatItem[], candidates: ResultEntry[]): number[] {
  const targets = readTargets(items)
  const newest = new Map<string, number>()
  const superseded: number[] = []
  for (const entry of candidates) {
    if (entry.item.name !== "read") continue
    const target = targets.get(entry.item.callId)
    if (target === undefined) continue
    const previous = newest.get(target)
    if (previous !== undefined) superseded.push(previous)
    newest.set(target, entry.index)
  }
  return superseded
}

/** Read targets by call id, resolved from the assistant tool-call that produced each result. */
function readTargets(items: ChatItem[]): Map<string, string> {
  const targets = new Map<string, string>()
  for (const item of items) {
    if (item.type !== "assistant") continue
    for (const part of item.parts) {
      if (part.type !== "tool-call" || part.name !== "read") continue
      if (part.input === null || typeof part.input !== "object") continue
      const filePath = (part.input as Record<string, unknown>)["filePath"]
      if (typeof filePath === "string") targets.set(part.callId, filePath)
    }
  }
  return targets
}

function clearRewrites(items: ChatItem[], keepRecent: number): Rewrite[] {
  const entries = toolResults(items)
  return entries
    .slice(0, Math.max(0, entries.length - keepRecent))
    .filter((entry) => replaceable(entry.item.result.output, CLEARED_PLACEHOLDER))
    .map((entry) => ({ ...entry, output: CLEARED_PLACEHOLDER }))
}

function replaceable(output: string, placeholder: string): boolean {
  return !PLACEHOLDERS.has(output) && output.length > placeholder.length
}

/**
 * Whether the provider is likely still serving a cached prefix: direct evidence from GLM's cached
 * token count, falling back to time since the last turn when no call has reported usage yet.
 */
function isCacheHot(items: ChatItem[], options: CompressionOptions): boolean {
  const last = lastAssistantWithUsage(items)
  if (last === undefined) return false
  if (last.usage.cachedInput > 0) return true
  return options.now - last.ts < options.idleMs
}

function isIdle(items: ChatItem[], options: CompressionOptions): boolean {
  const last = lastAssistant(items)
  if (last === undefined) return false
  return options.now - last.ts >= options.idleMs
}

function lastAssistantWithUsage(items: ChatItem[]): AssistantMessage | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item?.type === "assistant" && item.usage.input > 0) return item
  }
  return undefined
}

function lastAssistant(items: ChatItem[]): AssistantMessage | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item?.type === "assistant") return item
  }
  return undefined
}
