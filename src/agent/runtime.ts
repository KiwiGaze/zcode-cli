import { ToolRegistry } from "@/tools/registry"
import { PermissionEngine } from "@/permissions/policy"
import { FileState } from "@/tools/file-state"
import { TodoState } from "@/tools/todo-state"
import { builtinTools } from "@/tools/builtin"
import type { InstructionFile } from "@/agent/instructions"
import type { CompactionRecord } from "@/session/store"
import type { ResolvedConfig } from "@/config/config"

export interface AgentRuntime {
  registry: ToolRegistry
  permissions: PermissionEngine
  files: FileState
  todos: TodoState
  instructions: InstructionFile[]
  compactions: CompactionRecord[]
}

export function createRuntime(config: ResolvedConfig): AgentRuntime {
  const todos = new TodoState()
  return {
    registry: new ToolRegistry(builtinTools(todos)),
    permissions: new PermissionEngine(config),
    files: new FileState(),
    todos,
    instructions: [],
    compactions: [],
  }
}
