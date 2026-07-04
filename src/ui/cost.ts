import type { ResolvedConfig } from "@/config/config"
import { modelInfo } from "@/config/config"
import type { TokenUsage } from "@/session/messages"

const PER_MILLION = 1_000_000

export function estimateCost(config: ResolvedConfig, model: string, usage: TokenUsage): number {
  const pricing = modelInfo(config, model)?.pricing
  if (pricing === undefined) return 0
  const uncachedInput = Math.max(0, usage.input - usage.cachedInput)
  const cost =
    (uncachedInput * pricing.input + usage.cachedInput * pricing.cachedInput + usage.output * pricing.output) /
    PER_MILLION
  return cost
}

export function formatCost(costUsd: number): string {
  if (costUsd <= 0) return "$0.00"
  if (costUsd < 0.01) return "<$0.01"
  return `$${costUsd.toFixed(2)}`
}

export function formatTokens(usage: TokenUsage): string {
  const total = usage.input + usage.output
  if (total < 1000) return `${total} tok`
  return `${(total / 1000).toFixed(1)}k tok`
}
