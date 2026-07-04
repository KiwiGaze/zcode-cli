import React from "react"
import { Box, Text } from "ink"
import { theme } from "@/ui/theme"
import type { TodoItem } from "@/tools/todo-state"

const GLYPH: Record<TodoItem["status"], string> = {
  pending: "○",
  in_progress: "◐",
  completed: "●",
  cancelled: "⊘",
}

const COLOR: Record<TodoItem["status"], string> = {
  pending: theme.dim,
  in_progress: theme.accent,
  completed: theme.toolOk,
  cancelled: theme.dim,
}

export function TodoPanel({ todos }: { todos: TodoItem[] }): React.ReactElement | null {
  const active = todos.filter((todo) => todo.status !== "completed" && todo.status !== "cancelled")
  if (active.length === 0) return null
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.dim}>todos</Text>
      {todos.map((todo) => (
        <Text key={todo.id} color={COLOR[todo.status]}>
          {"  "}
          {GLYPH[todo.status]} <Text strikethrough={todo.status === "completed"}>{todo.content}</Text>
        </Text>
      ))}
    </Box>
  )
}
