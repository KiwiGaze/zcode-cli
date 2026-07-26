import React from "react"
import { Box, Text } from "ink"
import { sanitizeTerminalText } from "@/ui/terminal-text"
import { useTheme, type SemanticTheme } from "@/ui/theme"
import type { TodoItem } from "@/tools/todo-state"

const GLYPH: Record<TodoItem["status"], string> = {
  pending: "○",
  in_progress: "◐",
  completed: "●",
  cancelled: "⊘",
}

export function TodoPanel({ todos }: { todos: TodoItem[] }): React.ReactElement | null {
  const theme = useTheme()
  const active = todos.filter((todo) => todo.status !== "completed" && todo.status !== "cancelled")
  if (active.length === 0) return null
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.text.muted}>todos</Text>
      {todos.map((todo) => (
        <Text key={todo.id} color={todoColor(theme, todo.status)}>
          {"  "}
          {GLYPH[todo.status]}{" "}
          <Text strikethrough={theme.colorsEnabled && todo.status === "completed"}>
            {sanitizeTerminalText(todo.content)}
          </Text>
        </Text>
      ))}
    </Box>
  )
}

function todoColor(theme: SemanticTheme, status: TodoItem["status"]): string | undefined {
  if (status === "in_progress") return theme.text.accent
  if (status === "completed") return theme.status.ok
  return theme.text.muted
}
