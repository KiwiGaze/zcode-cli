import os from "node:os"
import path from "node:path"
import { readdir } from "node:fs/promises"
import { expandPath, globalConfigDir, projectChain } from "@/config/paths"
import type { ResolvedConfig } from "@/config/config"
import { parseAgentFile } from "@/subagents/frontmatter"
import { builtinAgents } from "@/subagents/builtin"
import type { AgentDefinition } from "@/subagents/types"

export interface DiscoveredAgents {
  agents: AgentDefinition[]
  warnings: string[]
}

/**
 * Scan project and global locations for `<name>.md` agent definitions. Visit order is precedence:
 * the first definition claiming a name wins, so nearer directories override farther ones and disk
 * files override built-ins. Parse failures are collected as warnings and skipped; never throws.
 */
export async function discoverAgents(cwd: string, config: ResolvedConfig): Promise<DiscoveredAgents> {
  const warnings: string[] = []
  try {
    const ordered: AgentDefinition[] = []
    for (const root of await agentRoots(cwd, config)) {
      for (const file of await listAgentFiles(root)) {
        const loaded = await loadAgent(file, warnings)
        if (loaded !== null) ordered.push(loaded)
      }
    }
    // Built-ins come last so a same-named disk agent wins the first-wins dedupe.
    ordered.push(...builtinAgents())

    const seen = new Set<string>()
    const disabled = new Set(config.agents.disabled)
    const agents = ordered.filter((agent) => {
      if (seen.has(agent.name) || disabled.has(agent.name)) return false
      seen.add(agent.name)
      return true
    })
    return { agents, warnings }
  } catch (error) {
    warnings.push(`agent discovery failed: ${error instanceof Error ? error.message : String(error)}`)
    // Never hand back an empty catalog: the default subagent type would stop resolving for the
    // rest of the session, and every caller assigns this result straight onto the runtime.
    return { agents: builtinAgents(), warnings }
  }
}

async function agentRoots(cwd: string, config: ResolvedConfig): Promise<string[]> {
  const roots: string[] = []
  for (const dir of await projectChain(cwd)) {
    roots.push(path.join(dir, ".zcode", "agents"))
    if (config.agents.interop.claude) roots.push(path.join(dir, ".claude", "agents"))
  }
  roots.push(path.join(globalConfigDir(), "agents"))
  if (config.agents.interop.claude) roots.push(path.join(os.homedir(), ".claude", "agents"))
  for (const extra of config.agents.paths) roots.push(expandPath(extra, cwd))
  return roots
}

async function listAgentFiles(root: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => !entry.isDirectory() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => path.join(root, name))
}

async function loadAgent(location: string, warnings: string[]): Promise<AgentDefinition | null> {
  let parsed
  try {
    parsed = parseAgentFile(await Bun.file(location).text())
  } catch (error) {
    warnings.push(`skipped ${location}: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
  // An agent the model cannot see in the task description, or with no prompt, is a config error.
  if (parsed.description === undefined || parsed.description.trim().length === 0) {
    warnings.push(`skipped ${location}: missing description`)
    return null
  }
  if (parsed.body.length === 0) {
    warnings.push(`skipped ${location}: empty body`)
    return null
  }
  return {
    name: path.basename(location, ".md"),
    description: parsed.description,
    ...(parsed.allowedTools === undefined ? {} : { allowedTools: parsed.allowedTools }),
    ...(parsed.model === undefined ? {} : { model: parsed.model }),
    prompt: parsed.body,
    source: "disk",
    location,
  }
}
