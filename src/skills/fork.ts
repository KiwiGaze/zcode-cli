import type { ToolContext } from "@/tools/registry"
import type { ToolResult } from "@/tools/types"
import { skillGrantMatches } from "@/permissions/policy"
import { resolveChildToolNames, runSubagent } from "@/subagents/runner"
import { buildSystemPrompt } from "@/agent/system"
import type { AgentRuntime } from "@/agent/runtime"
import type { ResolvedConfig } from "@/config/config"
import type { Skill } from "@/skills/types"

/**
 * Run a `context: fork` skill in a subagent. The child gets the read-only toolset plus the tools
 * named in `allowed-tools`; matching permission requests are auto-approved and everything else is
 * denied, because no one is present to ask. The skill body is the child's *prompt*, so it keeps the
 * identity system prompt rather than the role-body prompt a typed agent gets.
 */
export async function runForkedSkill(
  parent: AgentRuntime,
  skill: Skill,
  body: string,
  ctx: ToolContext,
): Promise<ToolResult> {
  const allowed = skill.allowedTools ?? []
  const { names } = resolveChildToolNames(parent.registry, allowed)

  const config: ResolvedConfig = skill.model === undefined ? parent.config : { ...parent.config, model: skill.model }
  return runSubagent(
    parent,
    {
      description: `skill: ${skill.name} (forked)`,
      prompt: body,
      system: buildSystemPrompt(),
      toolNames: names,
      config,
      decidePermission: (request) => (skillGrantMatches(allowed, request) ? "allow-once" : "deny"),
    },
    ctx,
  )
}
