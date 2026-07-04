import React from "react"
import { Box, Text } from "ink"
import { theme } from "@/ui/theme"
import type { ToolView } from "@/ui/view"

const STATUS_GLYPH: Record<ToolView["status"], string> = {
  pending: "●",
  ok: "✓",
  error: "✗",
  denied: "⊘",
  aborted: "⊘",
}

const STATUS_COLOR: Record<ToolView["status"], string> = {
  pending: theme.toolPending,
  ok: theme.toolOk,
  error: theme.toolError,
  denied: theme.dim,
  aborted: theme.dim,
}

export function ToolCard({ tool, live }: { tool: ToolView; live: boolean }): React.ReactElement {
  const summary = tool.title.length > 0 ? tool.title : oneLineInput(tool.input)
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={STATUS_COLOR[tool.status]}>{STATUS_GLYPH[tool.status]} </Text>
        <Text color={theme.accent}>{tool.name}</Text>
        <Text color={theme.dim}> {truncate(summary, 80)}</Text>
      </Text>
      {live && tool.status === "pending" && tool.progress.length > 0 ? (
        <Text color={theme.dim}>  {truncate(lastLine(tool.progress), 80)}</Text>
      ) : null}
    </Box>
  )
}

function oneLineInput(input: unknown): string {
  if (input === null || input === undefined) return ""
  if (typeof input === "string") return input
  try {
    return JSON.stringify(input)
  } catch {
    return String(input)
  }
}

function lastLine(text: string): string {
  const lines = text.trimEnd().split("\n")
  return lines[lines.length - 1] ?? ""
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}
