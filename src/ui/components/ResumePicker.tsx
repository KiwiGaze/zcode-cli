import React from "react"
import { Box, Text, useInput } from "ink"
import { resolveKeyAction } from "@/ui/keybindings"
import { sanitizeTerminalLine } from "@/ui/terminal-text"
import { useTheme } from "@/ui/theme"
import type { SessionSummary } from "@/session/store"

export function ResumePicker({
  sessions,
  onSelect,
  onCancel,
  onFocusChange,
  focusReporting,
  isActive,
}: {
  sessions: SessionSummary[]
  onSelect: (session: SessionSummary) => void
  onCancel: () => void
  onFocusChange: (focused: boolean) => void
  focusReporting: boolean
  isActive: boolean
}): React.ReactElement {
  const theme = useTheme()
  const [index, setIndex] = React.useState(0)
  const visibleSessions = sessions.slice(0, 10)

  useInput(
    (input, key) => {
      const action = resolveKeyAction(input, key, { owner: "picker", focusReporting })
      if (action === "terminal.focus") {
        onFocusChange(true)
        return
      }
      if (action === "terminal.blur") {
        onFocusChange(false)
        return
      }
      if (action === "picker.cancel") {
        onCancel()
        return
      }
      if (visibleSessions.length === 0) return
      if (action === "picker.previous") setIndex((i) => (i - 1 + visibleSessions.length) % visibleSessions.length)
      else if (action === "picker.next") setIndex((i) => (i + 1) % visibleSessions.length)
      else if (action === "picker.accept") {
        const chosen = visibleSessions[index]
        if (chosen !== undefined) onSelect(chosen)
      }
    },
    { isActive },
  )

  if (sessions.length === 0) {
    return (
      <Box marginTop={1}>
        <Text color={theme.text.muted}>no saved sessions in this project (esc to close)</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.text.accent}>resume session (↑/↓, enter, esc)</Text>
      {visibleSessions.map((session, i) => (
        <Text key={session.id} color={i === index ? theme.text.accent : undefined}>
          {i === index ? "❯ " : "  "}
          {formatTime(session.updatedAt)}
          {"  "}
          {sanitizeTerminalLine(session.preview) || "(empty)"}
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
