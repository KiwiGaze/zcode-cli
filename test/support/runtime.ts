import { ToolRegistry, type AnyTool } from "@/tools/registry"
import { PermissionEngine } from "@/permissions/policy"
import { FileState } from "@/tools/file-state"
import { TodoState } from "@/tools/todo-state"
import { DeferredState } from "@/tools/deferred"
import { builtinAgents } from "@/subagents/builtin"
import type { AgentRuntime } from "@/agent/runtime"
import type { ResolvedConfig } from "@/config/config"

export function testRuntime(config: ResolvedConfig, tools: AnyTool[] = []): AgentRuntime {
  return {
    config,
    registry: new ToolRegistry(tools),
    permissions: new PermissionEngine(config),
    files: new FileState(),
    todos: new TodoState(),
    instructions: [],
    compactions: [],
    skills: [],
    deferred: new DeferredState(),
    agents: builtinAgents(),
  }
}
