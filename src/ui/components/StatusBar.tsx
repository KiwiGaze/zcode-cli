import React from "react"
import { Box, Text } from "ink"
import { theme } from "@/ui/theme"
import type { StatusInfo } from "@/ui/view"
import { formatCost, formatTokens } from "@/ui/cost"

export function StatusBar({ status, busy }: { status: StatusInfo; busy: boolean }): React.ReactElement {
  const segments = [
    `${status.provider} · ${status.model}`,
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
