import os from "node:os"
import path from "node:path"
import { readdir, realpath, stat } from "node:fs/promises"
import { globalConfigDir } from "@/config/paths"
import type { ResolvedConfig } from "@/config/config"
import type { Skill } from "@/skills/types"
import { parseSkillFile, type ParsedSkillFile } from "@/skills/frontmatter"
import { bundledSkills } from "@/skills/bundled"

const SKILL_FILE = "SKILL.md"

export interface DiscoveredSkills {
  skills: Skill[]
  warnings: string[]
}

/**
 * Scan project and global locations for `<name>/SKILL.md` skills. Visit order is precedence:
 * the first skill claiming a name wins, so nearer directories override farther ones and native
 * `.zcode/skills` overrides interop `.claude`/`.agents`. Parse failures are collected as warnings
 * and skipped; the scan never throws.
 */
export async function discoverSkills(cwd: string, config: ResolvedConfig): Promise<DiscoveredSkills> {
  const warnings: string[] = []
  try {
    const roots = await skillRoots(cwd, config)
    const ordered: Skill[] = []
    for (const root of roots) {
      for (const dir of await listSkillDirs(root)) {
        const loaded = await loadSkill(dir, warnings)
        if (loaded !== null) ordered.push(loaded)
      }
    }
    // Bundled skills come last so a same-named disk skill wins the first-wins dedupe.
    if (config.skills.bundled) ordered.push(...bundledSkills())
    const skills = await dedupe(ordered)
    const disabled = new Set(config.skills.disabled)
    return { skills: skills.filter((skill) => !disabled.has(skill.name)), warnings }
  } catch (error) {
    warnings.push(`skill discovery failed: ${error instanceof Error ? error.message : String(error)}`)
    return { skills: [], warnings }
  }
}

async function skillRoots(cwd: string, config: ResolvedConfig): Promise<string[]> {
  const roots: string[] = []
  for (const dir of await projectChain(cwd)) {
    roots.push(path.join(dir, ".zcode", "skills"))
    if (config.skills.interop.claude) roots.push(path.join(dir, ".claude", "skills"))
    if (config.skills.interop.agents) roots.push(path.join(dir, ".agents", "skills"))
  }
  const home = os.homedir()
  roots.push(path.join(globalConfigDir(), "skills"))
  if (config.skills.interop.claude) roots.push(path.join(home, ".claude", "skills"))
  if (config.skills.interop.agents) roots.push(path.join(home, ".agents", "skills"))
  for (const extra of config.skills.paths) roots.push(expandPath(extra, cwd))
  return roots
}

/** Directories from cwd up to the git root, nearest first, so nearer skills win. */
async function projectChain(cwd: string): Promise<string[]> {
  const root = await gitRoot(cwd)
  const chain: string[] = []
  let dir = path.resolve(cwd)
  while (true) {
    chain.push(dir)
    if (dir === root) break
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return chain
}

async function gitRoot(cwd: string): Promise<string> {
  let dir = path.resolve(cwd)
  while (true) {
    if (await isDir(path.join(dir, ".git"))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return path.resolve(cwd)
    dir = parent
  }
}

async function listSkillDirs(root: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => path.join(root, name))
}

async function loadSkill(dir: string, warnings: string[]): Promise<Skill | null> {
  const location = path.join(dir, SKILL_FILE)
  const file = Bun.file(location)
  if (!(await file.exists())) return null
  try {
    const parsed = parseSkillFile(await file.text())
    return toSkill(path.basename(dir), dir, location, parsed)
  } catch (error) {
    warnings.push(`skipped ${location}: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

function toSkill(name: string, dir: string, location: string, parsed: ParsedSkillFile): Skill {
  return {
    name,
    ...(parsed.description === undefined ? {} : { description: parsed.description }),
    ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
    ...(parsed.allowedTools === undefined ? {} : { allowedTools: parsed.allowedTools }),
    context: parsed.context,
    ...(parsed.agent === undefined ? {} : { agent: parsed.agent }),
    ...(parsed.model === undefined ? {} : { model: parsed.model }),
    ...(parsed.argumentHint === undefined ? {} : { argumentHint: parsed.argumentHint }),
    ...(parsed.arguments === undefined ? {} : { arguments: parsed.arguments }),
    userInvocable: parsed.userInvocable,
    disableModelInvocation: parsed.disableModelInvocation,
    ...(parsed.paths === undefined ? {} : { paths: parsed.paths }),
    source: "disk",
    dir,
    location,
    body: parsed.body,
  }
}

/** First-wins by name, then drop physical duplicates reached through symlinks. */
async function dedupe(ordered: Skill[]): Promise<Skill[]> {
  const byName = new Set<string>()
  const byReal = new Set<string>()
  const out: Skill[] = []
  for (const skill of ordered) {
    if (byName.has(skill.name)) continue
    if (skill.source === "disk") {
      const real = await realpathOr(skill.location)
      if (byReal.has(real)) continue
      byReal.add(real)
    }
    byName.add(skill.name)
    out.push(skill)
  }
  return out
}

async function realpathOr(target: string): Promise<string> {
  try {
    return await realpath(target)
  } catch {
    return target
  }
}

function expandPath(target: string, cwd: string): string {
  const expanded = target.startsWith("~/") ? path.join(os.homedir(), target.slice(2)) : target
  return path.resolve(cwd, expanded)
}

async function isDir(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory()
  } catch {
    return false
  }
}
