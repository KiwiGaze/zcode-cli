import React from "react"
import { Box, Text } from "ink"
import { theme } from "@/ui/theme"
import type { StatusInfo } from "@/ui/view"
import { formatCost, formatTokens } from "@/ui/cost"

function formatContext(tokens: number, window: number): string {
  if (window <= 0) return `${Math.round(tokens / 1000)}k ctx`
  const percent = Math.min(100, Math.round((tokens / window) * 100))
  return `${percent}% ctx`
}

export function StatusBar({ status, busy }: { status: StatusInfo; busy: boolean }): React.ReactElement {
  const segments = [
    `${status.provider} · ${status.model}`,
    formatContext(status.contextTokens, status.contextWindow),
    formatTokens(status.usage),
    formatCost(status.costUsd),
  ]
  if (status.planMode) segments.push("plan")
  return (
    <Box>
      <Text color={theme.dim}>
        {busy ? <Text color={theme.accent}>● </Text> : <Text color={theme.dim}>○ </Text>}
        {segments.join("  ·  ")}
      </Text>
    </Box>
  )
}
