import { grantToolName } from "@/permissions/policy"

export type AgentSource = "builtin" | "disk"

export interface AgentDefinition {
  /** Invocation name: the file stem for disk agents; matched against `task.subagent_type`. */
  name: string
  /** Shown in the task tool description; required for disk agents. */
  description: string
  /** Grant patterns, e.g. `"read"`, `"bash(git:*)"`. Absent means the read-only base set. */
  allowedTools?: string[]
  /** Model override for the child, e.g. `"glm-4.7"`. */
  model?: string
  /** The child's system prompt: the markdown body for disk agents. */
  prompt: string
  source: AgentSource
  /** Absolute file path; `"<builtin>"` for built-ins. */
  location: string
}

/** Tools every subagent gets, whatever else it is granted. */
export const READONLY_BASE = ["read", "grep", "glob", "webfetch"] as const

/** Never available to a child, even when a definition names them: no recursive spawning. */
export const CHILD_FORBIDDEN_TOOLS = new Set(["task", "skill"])

/** An agent elevates when it grants anything outside the read-only base, so it needs consent. */
export function isElevatingAgent(agent: AgentDefinition): boolean {
  const base = new Set<string>(READONLY_BASE)
  return (agent.allowedTools ?? []).some((pattern) => {
    const tool = grantToolName(pattern)
    return tool.length > 0 && !base.has(tool)
  })
}
