import React from "react"
import { Box, Text } from "ink"
import { theme } from "@/ui/theme"
import type { RenderedPart, ToolView, ViewItem } from "@/ui/view"
import { ToolCard } from "@/ui/components/ToolCard"

export function MessageView({ item }: { item: ViewItem }): React.ReactElement {
  switch (item.kind) {
    case "user":
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.user}>{"› "}{item.text}</Text>
        </Box>
      )
    case "assistant":
      return <AssistantView parts={item.parts} tools={item.tools} />
    case "notice":
      return (
        <Box marginTop={1}>
          <Text color={item.tone === "warn" ? theme.error : theme.dim}>{item.text}</Text>
        </Box>
      )
    case "error":
      return (
        <Box marginTop={1}>
          <Text color={theme.error}>error: {item.text}</Text>
        </Box>
      )
  }
}

export function AssistantView({
  parts,
  tools,
  live = false,
}: {
  parts: RenderedPart[]
  tools: Record<string, ToolView>
  live?: boolean
}): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      {parts.map((part, index) => (
        <PartView key={index} part={part} tools={tools} live={live} />
      ))}
    </Box>
  )
}

function PartView({
  part,
  tools,
  live,
}: {
  part: RenderedPart
  tools: Record<string, ToolView>
  live: boolean
}): React.ReactElement | null {
  if (part.type === "reasoning") {
    if (part.text.trim().length === 0) return null
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text color={theme.reasoning} italic>
          {part.text.trim()}
        </Text>
      </Box>
    )
  }
  if (part.type === "text") {
    if (part.text.length === 0) return null
    return <Text>{part.text}</Text>
  }
  const tool = tools[part.callId]
  if (tool === undefined) return null
  return <ToolCard tool={tool} live={live} />
}
