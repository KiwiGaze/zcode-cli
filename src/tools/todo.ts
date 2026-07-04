import { z } from "zod"
import { defineTool, type AnyTool } from "@/tools/registry"
import { okResult } from "@/tools/types"
import type { TodoState, TodoItem } from "@/tools/todo-state"

import DESCRIPTION from "@/tools/prompts/todowrite.txt"

const TodoSchema = z.object({
  id: z.string().describe("Stable identifier for the todo item"),
  content: z.string().describe("What needs to be done"),
  status: z.enum(["pending", "in_progress", "completed", "cancelled"]).describe("Current status"),
})

const Schema = z.object({
  todos: z.array(TodoSchema).describe("The full, updated todo list"),
})
type Input = z.infer<typeof Schema>

export function createTodoTool(state: TodoState): AnyTool {
  return defineTool<Input>({
    name: "todowrite",
    description: DESCRIPTION,
    inputSchema: Schema,
    permission: () => null,
    execute: async (input) => {
      const items: TodoItem[] = input.todos.map((todo) => ({ id: todo.id, content: todo.content, status: todo.status }))
      state.replace(items)
      const remaining = items.filter((item) => item.status !== "completed" && item.status !== "cancelled").length
      return okResult(JSON.stringify(items), `${remaining} todo${remaining === 1 ? "" : "s"} remaining`, { todos: items })
    },
  })
}
