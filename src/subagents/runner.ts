import { ToolRegistry, type ToolContext } from "@/tools/registry"
import { okResult, errorResult, type ToolResult } from "@/tools/types"
import { FileState } from "@/tools/file-state"
import { TodoState } from "@/tools/todo-state"
import { childDeferredState } from "@/tools/deferred"
import { createSession } from "@/session/session"
import { assistantText } from "@/session/messages"
import type { AgentEvent } from "@/agent/events"
import type { AgentRuntime } from "@/agent/runtime"
import type { ResolvedConfig } from "@/config/config"
import type { PermissionDecision, PermissionRequest } from "@/permissions/types"

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
  onEvent?: (event: AgentEvent) => void
}

/**
 * Run one child agent to completion and return its report. The child gets a fresh session, file and
 * todo state, and a registry filtered by name from the parent's — a definition can only ever narrow
 * what exists, never conjure a tool.
 */
export async function runSubagent(parent: AgentRuntime, run: SubagentRun, ctx: ToolContext): Promise<ToolResult> {
  const { query } = await import("@/agent/query")
  const childRuntime: AgentRuntime = {
    config: run.config,
    registry: new ToolRegistry(parent.registry.list().filter((tool) => run.toolNames.has(tool.name))),
    permissions: parent.permissions,
    files: new FileState(),
    todos: new TodoState(),
    instructions: parent.instructions,
    compactions: [],
    skills: [],
    deferred: childDeferredState(run.toolNames, run.config),
    // A child never spawns further children, so it needs no agent catalog of its own.
    agents: [],
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
      deps: { system: run.system },
    })) {
      run.onEvent?.(event)
      switch (event.type) {
        case "permission-ask":
          // A subagent is headless. In auto mode a grant-matching approval here would be exactly
          // the laundering path: the parent's classifier blocks an action, the model delegates the
          // same action to a child, and the child approves it with nobody watching.
          event.respond(parent.permissions.isAutoMode() ? "deny" : run.decidePermission(event.request))
          break
        case "tool-start":
          ctx.onProgress(`  ${event.name}\n`)
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
