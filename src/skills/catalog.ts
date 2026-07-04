import path from "node:path"
import type { Skill } from "@/skills/types"

const LINE_CAPS = [250, 120, 60]

export interface CatalogOptions {
  budgetChars: number
  /** Absolute paths touched this session; a skill with `paths` appears only when one matches. */
  activePaths?: string[]
}

/** Render the system-prompt "Available skills" section, or "" when nothing is advertised. */
export function formatSkillCatalog(skills: Skill[], options: CatalogOptions): string {
  const activePaths = options.activePaths ?? []
  const visible = skills.filter((skill) => inCatalog(skill, activePaths))
  if (visible.length === 0) return ""
  const body = fitBudget(visible, options.budgetChars)
  return [
    "# Available skills",
    "When a task matches one of these, call the `skill` tool with its name to load full instructions.",
    body,
  ].join("\n")
}

function inCatalog(skill: Skill, activePaths: string[]): boolean {
  if (skill.description === undefined) return false
  if (skill.disableModelInvocation) return false
  if (skill.paths === undefined || skill.paths.length === 0) return true
  return skill.paths.some((glob) => matchesAny(glob, activePaths))
}

function matchesAny(glob: string, paths: string[]): boolean {
  const matcher = new Bun.Glob(glob)
  return paths.some((target) => {
    const relative = target.replace(/^\/+/, "")
    return matcher.match(target) || matcher.match(relative) || matcher.match(path.basename(target))
  })
}

function fitBudget(skills: Skill[], budget: number): string {
  for (const cap of LINE_CAPS) {
    const text = skills.map((skill) => catalogLine(skill, cap)).join("\n")
    if (text.length <= budget) return text
  }
  const names = skills.map((skill) => `- ${skill.name}`)
  const text = names.join("\n")
  return text.length <= budget ? text : clampToBudget(names, budget)
}

function catalogLine(skill: Skill, cap: number): string {
  const description = skill.description ?? ""
  const when = skill.whenToUse === undefined ? "" : ` Use when ${skill.whenToUse}`
  const line = `- ${skill.name}: ${description}${when}`
  return line.length > cap ? `${line.slice(0, cap - 1)}…` : line
}

function clampToBudget(lines: string[], budget: number): string {
  const kept: string[] = []
  let used = 0
  for (const line of lines) {
    const add = (kept.length > 0 ? 1 : 0) + line.length
    if (used + add > budget) break
    kept.push(line)
    used += add
  }
  return kept.join("\n")
}
