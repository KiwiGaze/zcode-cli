import { ToolRegistry } from "@/tools/registry"
import { PermissionEngine } from "@/permissions/policy"
import { FileState } from "@/tools/file-state"
import { TodoState } from "@/tools/todo-state"
import { builtinTools } from "@/tools/builtin"
import { createTaskTool } from "@/tools/task"
import { createSkillTool } from "@/skills/skill-tool"
import { createMemoryTool } from "@/memory/memory-tool"
import { createToolSearchTool } from "@/tools/tool-search"
import { DeferredState } from "@/tools/deferred"
import { memoryDir } from "@/config/paths"
import type { Skill } from "@/skills/types"
import type { AgentDefinition } from "@/subagents/types"
import { builtinAgents } from "@/subagents/builtin"
import type { InstructionFile } from "@/agent/instructions"
import type { CompactionRecord } from "@/session/store"
import type { ResolvedConfig } from "@/config/config"
import type { LLMStreamFn } from "@/llm/types"
import type { CompleteFn } from "@/llm/complete"
import type { PermissionDecision, PermissionRequest } from "@/permissions/types"

export interface AgentRuntime {
  config: ResolvedConfig
  registry: ToolRegistry
  permissions: PermissionEngine
  files: FileState
  todos: TodoState
  instructions: InstructionFile[]
  compactions: CompactionRecord[]
  /** Skills discovered at startup; the catalog and `skill` tool read this. */
  skills: Skill[]
  /** Deferred MCP tools the model has activated this runtime. */
  deferred: DeferredState
  /** Subagent types discovered at startup; the `task` tool resolves against this. */
  agents: AgentDefinition[]
  /** LLM transport override; subagents inherit it. Undefined = the real streaming client. */
  llm?: LLMStreamFn
  /** Side-call transport override; subagents inherit it, so a classifier fake reaches children. */
  complete?: CompleteFn
  /** Headless permission boundary applied before the shared parent policy. */
  decidePermission?: (request: PermissionRequest) => PermissionDecision
}

export function createRuntime(config: ResolvedConfig): AgentRuntime {
  const todos = new TodoState()
  const registry = new ToolRegistry(builtinTools(todos))
  const runtime: AgentRuntime = {
    config,
    registry,
    permissions: new PermissionEngine(config),
    files: new FileState(),
    todos,
    instructions: [],
    compactions: [],
    skills: [],
    deferred: new DeferredState(),
    // Built-ins are available before discovery runs; discovery replaces the list and re-adds them.
    agents: builtinAgents(),
  }
  registry.register(createTaskTool(runtime))
  registry.register(createSkillTool(runtime))
  registry.register(createToolSearchTool(runtime))
  if (config.memory.enabled) registry.register(createMemoryTool(memoryDir(config.cwd)))
  return runtime
}

/**
 * Install a discovered agent catalog. The task tool bakes the type list into its description, so it
 * is rebuilt in the same step — a catalog the model cannot see is a catalog it cannot select from.
 */
export function setAgents(runtime: AgentRuntime, agents: AgentDefinition[]): void {
  runtime.agents = agents
  runtime.registry.register(createTaskTool(runtime))
}
