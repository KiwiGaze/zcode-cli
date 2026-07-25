import type { ResolvedConfig } from "@/config/config"
import { modelInfo } from "@/config/config"
import type { TokenUsage } from "@/session/messages"

const PER_MILLION = 1_000_000

export interface BudgetLimits {
  /** Per `query()` invocation; undefined = unlimited. */
  maxTurns?: number
  /** Per session; undefined = unlimited. */
  maxCostUsd?: number
  /** Fraction of a limit that triggers a warning; 1 disables warnings. */
  warnAt: number
}

/** Which limit produced a verdict. A warning dedupes on this, never on its text: the message
 *  carries the running total, so it differs on every turn. */
export type BudgetLimitKind = "turns" | "cost"

export type BudgetVerdict =
  { kind: "ok" } | { kind: "warn"; limit: BudgetLimitKind; reason: string } | { kind: "exceeded"; reason: string }

/** One iteration's consumption against the limits. Exceeded wins over warn; cost is checked first. */
export function evaluateBudget(limits: BudgetLimits, state: { turns: number; costUsd: number }): BudgetVerdict {
  if (limits.maxCostUsd !== undefined && state.costUsd >= limits.maxCostUsd) {
    return { kind: "exceeded", reason: costLimitReason(state.costUsd, limits.maxCostUsd) }
  }
  if (limits.maxTurns !== undefined && state.turns >= limits.maxTurns) {
    return { kind: "exceeded", reason: `turn limit reached (${state.turns}/${limits.maxTurns} turns)` }
  }
  if (limits.maxCostUsd !== undefined && state.costUsd >= limits.maxCostUsd * limits.warnAt) {
    return {
      kind: "warn",
      limit: "cost",
      reason: `cost budget: $${state.costUsd.toFixed(2)} of $${limits.maxCostUsd.toFixed(2)} used`,
    }
  }
  if (limits.maxTurns !== undefined && state.turns >= limits.maxTurns * limits.warnAt) {
    return { kind: "warn", limit: "turns", reason: `turn budget: ${state.turns} of ${limits.maxTurns} turns used` }
  }
  return { kind: "ok" }
}

/** The one wording for a spent cost budget, so the turn gate and an autonomous run agree. */
export function costLimitReason(spentUsd: number, limitUsd: number): string {
  return `cost limit reached ($${spentUsd.toFixed(4)} >= $${limitUsd.toFixed(2)} budget)`
}

/** USD cost of a token total under the model's configured pricing. 0 when the model has no entry. */
export function estimateCost(config: ResolvedConfig, model: string, usage: TokenUsage): number {
  const pricing = modelInfo(config, model)?.pricing
  if (pricing === undefined) return 0
  const uncachedInput = Math.max(0, usage.input - usage.cachedInput)
  return (
    (uncachedInput * pricing.input + usage.cachedInput * pricing.cachedInput + usage.output * pricing.output) /
    PER_MILLION
  )
}

/** USD cost of model-attributed usage across a session. */
export function estimateSessionCost(config: ResolvedConfig, usageByModel: Readonly<Record<string, TokenUsage>>): number {
  return Object.entries(usageByModel).reduce(
    (total, [model, usage]) => total + estimateCost(config, model, usage),
    0,
  )
}

/** Model-facing text paired with every un-executed tool call when the budget stops the loop. */
export function budgetRefusalOutput(reason: string): string {
  return `not executed: ${reason}`
}

/**
 * Cost enforcement needs pricing. A configured cost cap on a model with no pricing entry would
 * silently do nothing, so callers disclose it once and fall open on cost only.
 */
export function costEnforceable(config: ResolvedConfig, model: string): boolean {
  return modelInfo(config, model)?.pricing !== undefined
}

export function unpricedModelWarning(model: string): string {
  return `cost unknown for model "${model}"; cost budget not enforced`
}
