import { z } from "zod"
import { defineTool, type AnyTool } from "@/tools/registry"
import { errorResult } from "@/tools/types"
import { buildSubagentPrompt } from "@/agent/system"
import { skillGrantMatches } from "@/permissions/policy"
import { resolveChildToolNames, runSubagent } from "@/subagents/runner"
import { isElevatingAgent, type AgentDefinition } from "@/subagents/types"
import type { AgentRuntime } from "@/agent/runtime"
import type { ResolvedConfig } from "@/config/config"

const BASE_DESCRIPTION = `Delegate a focused sub-task to a subagent and get back its findings.

Use this to parallelize research or analysis: launch one task per independent question and they run
concurrently. A subagent cannot spawn further subagents, and it sees only the prompt you give it —
so make the prompt self-contained and ask for exactly the summary you need.

Pass subagent_type to pick the kind of subagent. Omit it for a general read-only search.`

const DEFAULT_TYPE = "explore"

const Schema = z.object({
  description: z.string().describe("A short (3-5 word) label for the sub-task"),
  prompt: z.string().describe("The full, self-contained instruction for the subagent"),
  subagent_type: z.string().optional().describe("Which kind of subagent to use; omit for the default"),
})
type Input = z.infer<typeof Schema>

/**
 * Built with the agent list baked into its description, so it is re-registered after discovery or a
 * reload. Type resolution happens at execute time, because the JSON schema is frozen when the tool
 * is defined while agents are discovered afterwards.
 */
export function createTaskTool(parent: AgentRuntime): AnyTool {
  return defineTool<Input>({
    name: "task",
    description: describeAgents(parent),
    inputSchema: Schema,
    permission: (input, ctx) => {
      const agent = findAgent(parent, input.subagent_type)
      if (agent === undefined || !isElevatingAgent(agent)) return null
      return {
        tool: "task",
        callId: ctx.callId,
        title: `agent: ${agent.name}`,
        detail: `grants: ${(agent.allowedTools ?? []).join(", ")}`,
        key: agentPermissionKey(agent),
        subject: agent.name,
      }
    },
    execute: async (input, ctx) => {
      const requested = input.subagent_type ?? DEFAULT_TYPE
      const agent = findAgent(parent, input.subagent_type)
      if (agent === undefined) {
        const names = parent.agents.map((candidate) => candidate.name)
        return errorResult(`unknown subagent type: ${requested}. Available: ${names.join(", ") || "(none)"}`)
      }

      const grants = agent.allowedTools ?? []
      const { names, rejected } = resolveChildToolNames(parent.registry, grants)
      const label = `${agent.name}: ${input.description}`
      if (rejected.length > 0) ctx.onProgress(`▸ ${label} (tools not granted: ${rejected.join(", ")})\n`)

      const config: ResolvedConfig =
        agent.model === undefined ? parent.config : { ...parent.config, model: agent.model }

      return runSubagent(
        parent,
        {
          description: label,
          prompt: input.prompt,
          system: buildSubagentPrompt(agent.prompt, config),
          toolNames: names,
          config,
          decidePermission: (request) => (skillGrantMatches(grants, request) ? "allow-once" : "deny"),
        },
        ctx,
      )
    },
  })
}

function agentPermissionKey(agent: AgentDefinition): string {
  const grants = [...new Set(agent.allowedTools ?? [])].sort()
  return `agent:${agent.name}:${JSON.stringify(grants)}`
}

function findAgent(runtime: AgentRuntime, requested: string | undefined): AgentDefinition | undefined {
  return runtime.agents.find((agent) => agent.name === (requested ?? DEFAULT_TYPE))
}

function describeAgents(runtime: AgentRuntime): string {
  if (runtime.agents.length === 0) return BASE_DESCRIPTION
  const lines = runtime.agents.map((agent) => `- ${agent.name}: ${agent.description}`)
  return `${BASE_DESCRIPTION}\n\nAvailable subagent types:\n${lines.join("\n")}`
}
