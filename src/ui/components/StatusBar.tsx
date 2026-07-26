import React from "react"
import { Box, Text } from "ink"
import { useTheme } from "@/ui/theme"
import { sanitizeTerminalLine } from "@/ui/terminal-text"
import type { ActivityState, ContextStatus, StatusInfo } from "@/ui/view"
import { formatCost, formatTokens } from "@/ui/cost"

interface StatusSegment {
  key: string
  text: string
  color?: string
}

function formatAutonomy(status: NonNullable<StatusInfo["autonomy"]>): string {
  if (status.kind === "goal") return `goal · eval ${status.evaluation}/${status.maxEvaluations}`
  if (status.nextInSeconds !== undefined) return `loop · next in ${status.nextInSeconds}s`
  return `loop ${status.mode} · tick ${status.tick}/${status.maxTicks}`
}

export function StatusBar({
  status,
  activity,
  width,
}: {
  status: StatusInfo
  activity: ActivityState
  width: number
}): React.ReactElement {
  const theme = useTheme()
  const activitySegment: StatusSegment = {
    key: "activity",
    text: activity.kind === "idle" ? "○" : activity.kind === "compaction" ? "◆" : "●",
    color: activity.kind === "idle" ? theme.text.muted : theme.text.accent,
  }
  const modelSegment: StatusSegment = {
    key: "model",
    text:
      width >= 80
        ? `${sanitizeTerminalLine(status.provider)} · ${sanitizeTerminalLine(status.model)}`
        : sanitizeTerminalLine(status.model),
    color: theme.text.muted,
  }
  const contextStatusSegment = contextSegment(status.context, theme.status.warn, theme.status.error)
  const optionalSegments: StatusSegment[] = []

  if (width >= 60) {
    if (status.planMode) optionalSegments.push({ key: "plan", text: "plan", color: theme.text.accent })
    if (status.autoMode) optionalSegments.push({ key: "auto", text: "auto", color: theme.status.warn })
    if (status.autonomy !== undefined) {
      optionalSegments.push({
        key: "autonomy",
        text: formatAutonomy(status.autonomy),
        color: theme.text.accent,
      })
    }
    const cache = cacheSegment(status.latestResponseUsage)
    if (cache !== undefined) {
      optionalSegments.push({ key: "cache", text: cache, color: theme.text.muted })
    }
  }

  if (width >= 80) {
    const detail = contextDetail(status.context, activity)
    if (detail !== undefined) {
      optionalSegments.push({ key: "context-detail", text: detail, color: theme.text.muted })
    }
  }

  if (width >= 100) {
    optionalSegments.push(
      { key: "tokens", text: formatTokens(status.usage), color: theme.text.muted },
      { key: "cost", text: formatCost(status.costUsd), color: theme.text.muted },
    )
  }

  if (width >= 120 && status.compressionNote !== undefined) {
    optionalSegments.push({
      key: "compression",
      text: status.compressionNote,
      color: theme.text.muted,
    })
  }

  return (
    <Box width={width}>
      <Box flexShrink={0}>
        <Text color={activitySegment.color}>{activitySegment.text}</Text>
        <Text color={theme.text.muted}> · </Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} minWidth={8}>
        <Text color={modelSegment.color} wrap="truncate-end">
          {modelSegment.text}
        </Text>
      </Box>
      <Box flexShrink={0}>
        <Text color={theme.text.muted}> · </Text>
        <Text color={contextStatusSegment.color}>{contextStatusSegment.text}</Text>
      </Box>
      {optionalSegments.length === 0 ? null : (
        <Box flexShrink={1}>
          <Text wrap="truncate-end">
            {optionalSegments.map((segment) => (
              <React.Fragment key={segment.key}>
                <Text color={theme.text.muted}> · </Text>
                <Text color={segment.color}>{segment.text}</Text>
              </React.Fragment>
            ))}
          </Text>
        </Box>
      )}
    </Box>
  )
}

function contextSegment(
  context: ContextStatus,
  warnColor: string | undefined,
  errorColor: string | undefined,
): StatusSegment {
  if (context.kind === "unknownAfterCompaction") {
    return { key: "context", text: "ctx ? · compacted", color: warnColor }
  }
  const percent = contextPercent(context)
  return {
    key: "context",
    text: `ctx ${context.kind === "estimated" ? "~" : ""}${percent}%`,
    color: percent >= 92 ? errorColor : percent >= 80 ? warnColor : undefined,
  }
}

function contextDetail(context: ContextStatus, activity: ActivityState): string | undefined {
  if (context.kind === "unknownAfterCompaction") return undefined
  const ratio = context.window <= 0 ? 0 : context.tokens / context.window
  if (ratio >= context.compactAtRatio) {
    return activity.kind === "compaction" ? "compacting" : undefined
  }
  return `${Math.max(0, Math.round((context.compactAtRatio - ratio) * 100))}% to compact`
}

function contextPercent(context: Exclude<ContextStatus, { kind: "unknownAfterCompaction" }>): number {
  if (context.window <= 0) return 0
  return Math.min(100, Math.max(0, Math.round((context.tokens / context.window) * 100)))
}

function cacheSegment(usage: StatusInfo["latestResponseUsage"]): string | undefined {
  if (usage === undefined || usage.input <= 0 || usage.cachedInput <= 0) return undefined
  return `cache ${Math.min(100, Math.round((usage.cachedInput / usage.input) * 100))}%`
}
