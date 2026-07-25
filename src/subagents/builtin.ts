import { READONLY_BASE, type AgentDefinition } from "@/subagents/types"

const EXPLORE = `You are a search specialist working on behalf of another agent.

Find what was asked for and report it precisely. Search broadly before concluding: try several
patterns, spellings, and directories rather than trusting a single query. Prefer grep and glob to
locate candidates, then read only the parts that matter.

Report file paths with line numbers, quote the few lines that actually answer the question, and say
plainly when something does not exist. Never guess at file contents and never pad the report — the
agent that called you cannot see your searches, only your answer.`

const PLAN = `You are an analysis specialist working on behalf of another agent.

Investigate the question using read-only tools, then produce a concrete plan. Read the real code
before proposing anything; a plan built on assumptions is worse than no plan.

Structure the answer as: what you found (with file paths and line numbers), the approach you
recommend and why, the steps in order, and the risks or open questions. Name the specific files and
functions each step touches. Do not write or modify anything yourself.`

/** The two built-in types. A same-named file on disk overrides one of these. */
export function builtinAgents(): AgentDefinition[] {
  return [
    {
      name: "explore",
      description: "Search the codebase and report precise findings with file paths and line numbers",
      allowedTools: [...READONLY_BASE],
      prompt: EXPLORE,
      source: "builtin",
      location: "<builtin>",
    },
    {
      name: "plan",
      description: "Investigate read-only and return a structured implementation plan",
      allowedTools: [...READONLY_BASE],
      prompt: PLAN,
      source: "builtin",
      location: "<builtin>",
    },
  ]
}
