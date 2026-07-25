import { ToolRegistry, type ToolContext } from "@/tools/registry"
import { okResult, errorResult, type ToolResult } from "@/tools/types"
import { FileState } from "@/tools/file-state"
import { TodoState } from "@/tools/todo-state"
import { childDeferredState } from "@/tools/deferred"
import { createSession } from "@/session/session"
import { assistantText } from "@/session/messages"
import { skillGrantMatches } from "@/permissions/policy"
import type { AgentRuntime } from "@/agent/runtime"
import type { ResolvedConfig } from "@/config/config"
import type { Skill } from "@/skills/types"

/** Read-only tools a forked skill always has, on top of anything its `allowed-tools` grants. */
const FORK_READONLY = ["read", "grep", "glob", "webfetch"]

/**
 * Run a `context: fork` skill in a subagent, reusing the task engine. The child gets the read-only
 * toolset plus the tools named in `allowed-tools`; matching permission requests are auto-approved,
 * everything else is denied (no one is present to ask).
 */
export async function runForkedSkill(
  parent: AgentRuntime,
  skill: Skill,
  body: string,
  ctx: ToolContext,
): Promise<ToolResult> {
  const { query } = await import("@/agent/query")
  const allowed = skill.allowedTools ?? []
  const toolNames = new Set<string>(FORK_READONLY)
  for (const pattern of allowed) {
    const base = pattern.split("(")[0]?.trim()
    if (base !== undefined && base.length > 0) toolNames.add(base)
  }

  const config: ResolvedConfig = skill.model === undefined ? parent.config : { ...parent.config, model: skill.model }
  const childRuntime: AgentRuntime = {
    config,
    registry: new ToolRegistry(parent.registry.list().filter((tool) => toolNames.has(tool.name))),
    permissions: parent.permissions,
    files: new FileState(),
    todos: new TodoState(),
    instructions: parent.instructions,
    compactions: [],
    skills: [],
    deferred: childDeferredState(toolNames, config),
    ...(parent.llm === undefined ? {} : { llm: parent.llm }),
  }
  const childSession = createSession(ctx.cwd)

  ctx.onProgress(`▸ skill: ${skill.name} (forked)\n`)
  let finalText = ""
  try {
    for await (const event of query({
      prompt: body,
      session: childSession,
      config,
      runtime: childRuntime,
      signal: ctx.signal,
    })) {
      switch (event.type) {
        case "permission-ask":
          event.respond(skillGrantMatches(allowed, event.request) ? "allow-once" : "deny")
          break
        case "tool-start":
          ctx.onProgress(`  ${event.name}\n`)
          break
        case "done":
          finalText = assistantText(event.message)
          break
        case "error":
          return errorResult(`forked skill error: ${event.error.message}`)
        default:
          break
      }
    }
  } catch (error) {
    return errorResult(`forked skill failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  const output = finalText.trim()
  if (output.length === 0) return errorResult("forked skill produced no output")
  return okResult(output, `skill: ${skill.name} (forked)`)
}
