import type { TokenUsage } from "@/session/messages"

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
