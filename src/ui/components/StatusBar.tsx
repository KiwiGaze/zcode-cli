import React from "react"
import { Box, Text } from "ink"
import { theme } from "@/ui/theme"
import type { StatusInfo } from "@/ui/view"
import { formatCost, formatTokens } from "@/ui/cost"

function formatAutonomy(status: NonNullable<StatusInfo["autonomy"]>): string {
  if (status.kind === "goal") return `goal · eval ${status.evaluation}/${status.maxEvaluations}`
  if (status.nextInSeconds !== undefined) return `loop · next in ${status.nextInSeconds}s`
  return `loop ${status.mode} · tick ${status.tick}/${status.maxTicks}`
}

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
  if (status.autoMode) segments.push("auto")
  if (status.autonomy !== undefined) segments.push(formatAutonomy(status.autonomy))
  if (status.compressionNote !== undefined) segments.push(status.compressionNote)
  return (
    <Box>
      <Text color={theme.dim}>
        {busy ? <Text color={theme.accent}>● </Text> : <Text color={theme.dim}>○ </Text>}
        {segments.join("  ·  ")}
      </Text>
    </Box>
  )
}
