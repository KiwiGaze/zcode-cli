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
import type { InstructionFile } from "@/agent/instructions"
import type { CompactionRecord } from "@/session/store"
import type { ResolvedConfig } from "@/config/config"
import type { LLMStreamFn } from "@/llm/types"

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
  /** LLM transport override; subagents inherit it. Undefined = the real streaming client. */
  llm?: LLMStreamFn
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
  }
  registry.register(createTaskTool(runtime))
  registry.register(createSkillTool(runtime))
  registry.register(createToolSearchTool(runtime))
  if (config.memory.enabled) registry.register(createMemoryTool(memoryDir(config.cwd)))
  return runtime
}
