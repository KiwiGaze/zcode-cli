import React from "react"
import { Box, Text, useInput } from "ink"
import { theme } from "@/ui/theme"
import { matchCommands } from "@/commands/registry"

export interface InputBoxProps {
  onSubmit: (value: string) => void
  onAbort: () => void
  busy: boolean
  disabled: boolean
}

export function InputBox({ onSubmit, onAbort, busy, disabled }: InputBoxProps): React.ReactElement {
  const [buf, setBuf] = React.useState<{ value: string; cursor: number }>({ value: "", cursor: 0 })
  const { value, cursor } = buf
  const historyRef = React.useRef<string[]>([])
  const [historyIndex, setHistoryIndex] = React.useState<number | null>(null)

  useInput(
    (input, key) => {
      if (disabled) return

      if (key.escape) {
        if (busy) onAbort()
        else if (value.length > 0) setBuf({ value: "", cursor: 0 })
        return
      }

      if (key.return) {
        const submitted = value
        if (submitted.trim().length === 0) return
        historyRef.current = [...historyRef.current, submitted]
        setHistoryIndex(null)
        setBuf({ value: "", cursor: 0 })
        onSubmit(submitted)
        return
      }

      if (key.upArrow) {
        const history = historyRef.current
        if (history.length === 0) return
        const next = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1)
        setHistoryIndex(next)
        const recalled = history[next] ?? ""
        setBuf({ value: recalled, cursor: recalled.length })
        return
      }

      if (key.downArrow) {
        const history = historyRef.current
        if (historyIndex === null) return
        const next = historyIndex + 1
        if (next >= history.length) {
          setHistoryIndex(null)
          setBuf({ value: "", cursor: 0 })
        } else {
          setHistoryIndex(next)
          const recalled = history[next] ?? ""
          setBuf({ value: recalled, cursor: recalled.length })
        }
        return
      }

      if (key.leftArrow) {
        setBuf((b) => ({ ...b, cursor: Math.max(0, b.cursor - 1) }))
        return
      }
      if (key.rightArrow) {
        setBuf((b) => ({ ...b, cursor: Math.min(b.value.length, b.cursor + 1) }))
        return
      }

      if (key.backspace || key.delete) {
        setBuf((b) =>
          b.cursor === 0
            ? b
            : { value: b.value.slice(0, b.cursor - 1) + b.value.slice(b.cursor), cursor: b.cursor - 1 },
        )
        return
      }

      if (key.ctrl || key.meta) return
      if (input.length === 0) return

      const text = input.replace(/\r\n?/g, "\n")
      setBuf((b) => ({
        value: b.value.slice(0, b.cursor) + text + b.value.slice(b.cursor),
        cursor: b.cursor + text.length,
      }))
    },
    { isActive: !disabled },
  )

  const showCompletions = value.startsWith("/") && !value.includes(" ")
  const completions = showCompletions ? matchCommands(value) : []

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.accent}>{"❯ "}</Text>
        <Text>{renderWithCursor(value, cursor, disabled)}</Text>
      </Box>
      {completions.length > 0 ? (
        <Box flexDirection="column" marginLeft={2}>
          {completions.slice(0, 6).map((command) => (
            <Text key={command.name} color={theme.dim}>
              /{command.name} — {command.description}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  )
}

function renderWithCursor(value: string, cursor: number, disabled: boolean): React.ReactNode {
  if (disabled) return <Text color={theme.dim}>{value}</Text>
  const before = value.slice(0, cursor)
  const at = value.slice(cursor, cursor + 1) || " "
  const after = value.slice(cursor + 1)
  return (
    <Text>
      {before}
      <Text inverse>{at}</Text>
      {after}
    </Text>
  )
}
