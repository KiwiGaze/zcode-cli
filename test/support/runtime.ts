import { ToolRegistry, type AnyTool } from "@/tools/registry"
import { PermissionEngine } from "@/permissions/policy"
import { FileState } from "@/tools/file-state"
import { TodoState } from "@/tools/todo-state"
import type { AgentRuntime } from "@/agent/runtime"
import type { ResolvedConfig } from "@/config/config"

export function testRuntime(config: ResolvedConfig, tools: AnyTool[] = []): AgentRuntime {
  return {
    registry: new ToolRegistry(tools),
    permissions: new PermissionEngine(config),
    files: new FileState(),
    todos: new TodoState(),
    instructions: [],
    compactions: [],
  }
}
