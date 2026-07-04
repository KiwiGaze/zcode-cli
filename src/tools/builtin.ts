import { ToolRegistry, type AnyTool } from "@/tools/registry"
import { readTool } from "@/tools/read"
import { writeTool } from "@/tools/write"
import { editTool } from "@/tools/edit"
import { bashTool } from "@/tools/bash"
import { grepTool } from "@/tools/grep"
import { globTool } from "@/tools/glob"
import { webfetchTool } from "@/tools/webfetch"
import { createTodoTool } from "@/tools/todo"
import type { TodoState } from "@/tools/todo-state"

export function builtinTools(todoState: TodoState): AnyTool[] {
  return [readTool, writeTool, editTool, bashTool, grepTool, globTool, webfetchTool, createTodoTool(todoState)]
}

export function builtinRegistry(todoState: TodoState): ToolRegistry {
  return new ToolRegistry(builtinTools(todoState))
}
