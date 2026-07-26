import React from "react"
import { Box, Text } from "ink"
import { readSpillInfo } from "@/agent/spill"
import { EditToolInputSchema } from "@/tools/edit"
import { Diff } from "@/ui/components/Diff"
import { Spinner, STATIC_SPINNER_GLYPH } from "@/ui/components/Spinner"
import { sanitizeTerminalLine, sanitizeTerminalText } from "@/ui/terminal-text"
import { useTheme, type SemanticTheme } from "@/ui/theme"
import type { ToolView } from "@/ui/view"

const STATUS_GLYPH: Record<ToolView["status"], string> = {
  pending: STATIC_SPINNER_GLYPH,
  ok: "✓",
  error: "✗",
  denied: "⊘",
  aborted: "⊘",
}

export function ToolCard({
  tool,
  live,
  animations,
}: {
  tool: ToolView
  live: boolean
  animations: boolean
}): React.ReactElement {
  const theme = useTheme()
  const spill = readSpillInfo(tool.result?.metadata)
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text color={statusColor(theme, tool.status)}>
          {tool.status === "pending" ? <Spinner animated={animations && live} /> : STATUS_GLYPH[tool.status]}{" "}
        </Text>
        <Text color={theme.text.accent}>{sanitizeTerminalLine(tool.name)}</Text>
        <Text color={theme.text.muted}> {toolSummary(tool)}</Text>
        {spill === null ? null : (
          <Text color={theme.text.muted}>
            {" "}
            · {Math.round(spill.bytes / 1024)} KB saved to {sanitizeTerminalLine(spill.path)}
          </Text>
        )}
      </Text>
      <ToolPreview tool={tool} live={live} />
    </Box>
  )
}

function ToolPreview({ tool, live }: { tool: ToolView; live: boolean }): React.ReactElement | null {
  if (tool.status === "error" || tool.status === "denied" || tool.status === "aborted") {
    return <BoundedLines text={tool.result?.output ?? tool.title} mode="head" />
  }

  switch (tool.name) {
    case "bash":
      if (live && tool.status === "pending") {
        return tool.progress.length === 0 ? null : <BoundedLines text={lastLine(tool.progress)} mode="tail" />
      }
      return tool.result === undefined ? null : <BoundedLines text={tool.result.output} mode="tail" />
    case "edit":
      return <EditPreview tool={tool} />
    case "write":
      return <WritePreview tool={tool} />
    case "read":
    case "grep":
    case "glob":
      return null
    default:
      return null
  }
}

function EditPreview({ tool }: { tool: ToolView }): React.ReactElement | null {
  if (tool.status !== "ok") return null
  const input = EditToolInputSchema.safeParse(tool.input)
  if (!input.success) return <WritePreview tool={tool} />
  const metadata = changeMetadata(tool)
  const path = sanitizeTerminalLine(metadata.path ?? input.data.filePath)
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text wrap="truncate-end">
        replacement diff{input.data.replaceAll === true ? " · all occurrences" : ""} · {path}
        {metadata.additions === undefined ? "" : ` (+${metadata.additions} -${metadata.deletions ?? 0})`}
      </Text>
      <Diff oldText={input.data.oldString} newText={input.data.newString} />
    </Box>
  )
}

function WritePreview({ tool }: { tool: ToolView }): React.ReactElement | null {
  if (tool.status !== "ok") return null
  const metadata = changeMetadata(tool)
  if (metadata.path === undefined) return null
  return (
    <Text wrap="truncate-end">
      {"  "}
      {metadata.path}
      {metadata.additions === undefined ? "" : ` · +${metadata.additions} -${metadata.deletions ?? 0}`}
    </Text>
  )
}

function BoundedLines({ text, mode }: { text: string; mode: "head" | "tail" }): React.ReactElement {
  const theme = useTheme()
  const cleanLines = sanitizeTerminalText(text).trimEnd().split("\n")
  const isTruncated = cleanLines.length > 3
  const lines = mode === "tail" ? cleanLines.slice(-3) : cleanLines.slice(0, 3)
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {mode === "tail" && isTruncated ? <Text color={theme.text.muted}>output truncated</Text> : null}
      {lines.map((line, index) => (
        <Text key={index} color={theme.text.muted} wrap="truncate-end">
          {line}
        </Text>
      ))}
      {mode === "head" && isTruncated ? <Text color={theme.text.muted}>output truncated</Text> : null}
    </Box>
  )
}

function toolSummary(tool: ToolView): string {
  const title = sanitizeTerminalLine(tool.title.length > 0 ? tool.title : oneLineInput(tool.input))
  const metadata = tool.result?.metadata
  if (tool.name === "grep" && typeof metadata?.["matches"] === "number") {
    return `${title} · ${metadata["matches"]} match${metadata["matches"] === 1 ? "" : "es"}`
  }
  if (tool.name === "glob" && typeof metadata?.["count"] === "number") {
    return `${title} · ${metadata["count"]} file${metadata["count"] === 1 ? "" : "s"}`
  }
  return title
}

function changeMetadata(tool: ToolView): { path?: string; additions?: number; deletions?: number } {
  const metadata = tool.result?.metadata
  const path = metadata?.["path"]
  const additions = metadata?.["additions"]
  const deletions = metadata?.["deletions"]
  return {
    ...(typeof path === "string" ? { path: sanitizeTerminalLine(path) } : {}),
    ...(typeof additions === "number" ? { additions } : {}),
    ...(typeof deletions === "number" ? { deletions } : {}),
  }
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

function statusColor(theme: SemanticTheme, status: ToolView["status"]): string | undefined {
  switch (status) {
    case "pending":
      return theme.status.pending
    case "ok":
      return theme.status.ok
    case "error":
      return theme.status.error
    case "denied":
    case "aborted":
      return theme.text.muted
  }
}
