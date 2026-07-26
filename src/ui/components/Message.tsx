import React from "react"
import { Box, Text } from "ink"
import { useTheme } from "@/ui/theme"
import { sanitizeTerminalText } from "@/ui/terminal-text"
import type { RenderedPart, ToolView, ViewItem } from "@/ui/view"
import { Markdown } from "@/ui/components/Markdown"
import { ToolCard } from "@/ui/components/ToolCard"

export function MessageView({ item }: { item: ViewItem }): React.ReactElement {
  const theme = useTheme()
  switch (item.kind) {
    case "user":
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.status.ok}>
            {"› "}
            {sanitizeTerminalText(item.text)}
          </Text>
        </Box>
      )
    case "assistant":
      return <AssistantView parts={item.parts} tools={item.tools} animations={false} />
    case "notice":
      return (
        <Box marginTop={1}>
          <Text color={item.tone === "warn" ? theme.status.warn : theme.text.muted}>
            {sanitizeTerminalText(item.text)}
          </Text>
        </Box>
      )
    case "error":
      return (
        <Box marginTop={1}>
          <Text color={theme.status.error}>error: {sanitizeTerminalText(item.text)}</Text>
        </Box>
      )
  }
}

export function AssistantView({
  parts,
  tools,
  live = false,
  animations,
}: {
  parts: RenderedPart[]
  tools: Record<string, ToolView>
  live?: boolean
  animations: boolean
}): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      {parts.map((part, index) => (
        <PartView key={index} part={part} tools={tools} live={live} animations={animations} />
      ))}
    </Box>
  )
}

function PartView({
  part,
  tools,
  live,
  animations,
}: {
  part: RenderedPart
  tools: Record<string, ToolView>
  live: boolean
  animations: boolean
}): React.ReactElement | null {
  const theme = useTheme()
  if (part.type === "reasoning") {
    if (part.text.trim().length === 0) return null
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text color={theme.text.muted} italic={theme.colorsEnabled}>
          {sanitizeTerminalText(part.text.trim())}
        </Text>
      </Box>
    )
  }
  if (part.type === "text") {
    if (part.text.length === 0) return null
    return <Markdown text={part.text} live={live} />
  }
  const tool = tools[part.callId]
  if (tool === undefined) return null
  return <ToolCard tool={tool} live={live} animations={animations} />
}
