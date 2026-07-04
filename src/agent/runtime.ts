import { ToolRegistry } from "@/tools/registry"
import { PermissionEngine } from "@/permissions/policy"
import { FileState } from "@/tools/file-state"
import { TodoState } from "@/tools/todo-state"
import { builtinTools } from "@/tools/builtin"
import type { ResolvedConfig } from "@/config/config"

export interface AgentRuntime {
  registry: ToolRegistry
  permissions: PermissionEngine
  files: FileState
  todos: TodoState
}

export function createRuntime(config: ResolvedConfig): AgentRuntime {
  const todos = new TodoState()
  return {
    registry: new ToolRegistry(builtinTools(todos)),
    permissions: new PermissionEngine(config),
    files: new FileState(),
    todos,
  }
}
