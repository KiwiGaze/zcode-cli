import React from "react"
import { Box, Text, useInput } from "ink"
import { theme } from "@/ui/theme"
import type { SessionSummary } from "@/session/store"

export function ResumePicker({
  sessions,
  onSelect,
  onCancel,
}: {
  sessions: SessionSummary[]
  onSelect: (session: SessionSummary) => void
  onCancel: () => void
}): React.ReactElement {
  const [index, setIndex] = React.useState(0)

  useInput((_input, key) => {
    if (key.escape) {
      onCancel()
      return
    }
    if (sessions.length === 0) return
    if (key.upArrow) setIndex((i) => (i - 1 + sessions.length) % sessions.length)
    else if (key.downArrow) setIndex((i) => (i + 1) % sessions.length)
    else if (key.return) {
      const chosen = sessions[index]
      if (chosen !== undefined) onSelect(chosen)
    }
  })

  if (sessions.length === 0) {
    return (
      <Box marginTop={1}>
        <Text color={theme.dim}>no saved sessions in this project (esc to close)</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.accent}>resume session (↑/↓, enter, esc)</Text>
      {sessions.slice(0, 10).map((session, i) => (
        <Text key={session.id} color={i === index ? theme.accent : undefined}>
          {i === index ? "❯ " : "  "}
          {formatTime(session.updatedAt)}  {session.preview || "(empty)"}
        </Text>
      ))}
    </Box>
  )
}

function formatTime(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number): string => value.toString().padStart(2, "0")
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
