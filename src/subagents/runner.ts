import { ToolRegistry, type ToolContext } from "@/tools/registry"
import { okResult, errorResult, type ToolResult } from "@/tools/types"
import { grantToolName } from "@/permissions/policy"
import { CHILD_FORBIDDEN_TOOLS, READONLY_BASE } from "@/subagents/types"
import { FileState } from "@/tools/file-state"
import { TodoState } from "@/tools/todo-state"
import { createTodoTool } from "@/tools/todo"
import { childDeferredState } from "@/tools/deferred"
import { createSession } from "@/session/session"
import { assistantText } from "@/session/messages"
import type { AgentRuntime } from "@/agent/runtime"
import type { ResolvedConfig } from "@/config/config"
import type { PermissionDecision, PermissionRequest } from "@/permissions/types"

const READONLY_TOOLS = new Set<string>(READONLY_BASE)

export interface SubagentRun {
  /** Progress line and result title. */
  description: string
  /** The child's user message. */
  prompt: string
  /** The child's system prompt. */
  system: string
  /** Registry filter; `task` and `skill` must already be excluded. */
  toolNames: ReadonlySet<string>
  /** Parent config, or a copy with a model override applied. */
  config: ResolvedConfig
  /**
   * Headless permission policy. Nobody is present to ask, so this must answer every request.
   * It must never return `allow-session`: the child shares the parent's engine, and a session
   * grant made here would silently widen the parent's own permissions.
   */
  decidePermission: (request: PermissionRequest) => PermissionDecision
}

/**
 * The child's toolset: the read-only base plus the tool named by each grant, filtered against the
 * parent's registry. A name matching nothing yields no tool — a definition can never create one —
 * and parent-control tools are dropped even when granted. `rejected` lists everything dropped, for
 * callers that surface it.
 */
export function resolveChildToolNames(
  registry: ToolRegistry,
  grants: readonly string[],
): { names: Set<string>; rejected: string[] } {
  const requested = new Set<string>(READONLY_BASE)
  for (const pattern of grants) {
    const tool = grantToolName(pattern)
    if (tool.length > 0) requested.add(tool)
  }

  const names = new Set<string>()
  const rejected: string[] = []
  for (const name of requested) {
    if (!CHILD_FORBIDDEN_TOOLS.has(name) && registry.has(name)) names.add(name)
    else rejected.push(name)
  }
  return { names, rejected }
}

/**
 * Run one child agent to completion and return its report. The child gets a fresh session, file and
 * todo state, and a registry filtered by name from the parent's — a definition can only ever narrow
 * what exists, never conjure a tool.
 */
export async function runSubagent(parent: AgentRuntime, run: SubagentRun, ctx: ToolContext): Promise<ToolResult> {
  const { query } = await import("@/agent/query")
  const todos = new TodoState()
  const childRuntime: AgentRuntime = {
    config: run.config,
    registry: new ToolRegistry(
      parent.registry
        .list()
        .filter((tool) => run.toolNames.has(tool.name))
        .map((tool) => (tool.name === "todowrite" ? createTodoTool(todos) : tool)),
    ),
    permissions: parent.permissions,
    files: new FileState(),
    todos,
    instructions: parent.instructions,
    compactions: [],
    skills: [],
    deferred: childDeferredState(run.toolNames),
    // A child never spawns further children, so it needs no agent catalog of its own.
    agents: [],
    decidePermission: (request) =>
      READONLY_TOOLS.has(request.tool) ? "allow-once" : run.decidePermission(request),
    ...(parent.llm === undefined ? {} : { llm: parent.llm }),
    ...(parent.complete === undefined ? {} : { complete: parent.complete }),
  }
  const childSession = createSession(ctx.cwd)

  ctx.onProgress(`▸ ${run.description}\n`)
  let finalText = ""
  try {
    for await (const event of query({
      prompt: run.prompt,
      session: childSession,
      config: run.config,
      runtime: childRuntime,
      signal: ctx.signal,
      deps: {
        system: run.system,
        usageSession: ctx.usageSession,
        ...(ctx.persistUsage === undefined ? {} : { persistUsage: ctx.persistUsage }),
      },
    })) {
      switch (event.type) {
        case "permission-ask":
          event.respond("deny")
          break
        case "tool-start":
          ctx.onProgress(`  ${event.name}\n`)
          break
        case "budget-warning":
        case "budget-exceeded":
          ctx.onProgress(`  ${event.reason}\n`)
          break
        case "done":
          finalText = assistantText(event.message)
          break
        case "error":
          return errorResult(`subagent error: ${event.error.message}`)
        default:
          break
      }
    }
  } catch (error) {
    return errorResult(`subagent failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  const output = finalText.trim()
  if (output.length === 0) return errorResult("subagent produced no output")
  return okResult(output, run.description)
}
