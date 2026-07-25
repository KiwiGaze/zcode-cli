import { z } from "zod"
import { defineTool, type AnyTool, type ToolContext } from "@/tools/registry"
import { okResult, errorResult, type ToolResult } from "@/tools/types"
import type { AgentRuntime } from "@/agent/runtime"
import type { Skill } from "@/skills/types"
import { substituteArgs } from "@/skills/args"
import { runForkedSkill } from "@/skills/fork"

const DESCRIPTION =
  "Load a specialized skill listed under 'Available skills' in the session context. Injects its full " +
  "instructions and resources so you can follow them. Pass the skill name exactly as listed."

const MAX_SAMPLE_FILES = 10
const SAMPLE_SCAN_CAP = 200

const Schema = z.object({
  name: z.string().describe("The skill name to load, exactly as listed under 'Available skills'"),
  args: z.string().optional().describe("Optional arguments to pass to the skill"),
})
type Input = z.infer<typeof Schema>

/** A skill "elevates" when it grants tools or runs in a subagent, so its invocation needs approval. */
export function isElevatingSkill(skill: Skill): boolean {
  return (skill.allowedTools !== undefined && skill.allowedTools.length > 0) || skill.context === "fork"
}

export function createSkillTool(runtime: AgentRuntime): AnyTool {
  return defineTool<Input>({
    name: "skill",
    description: DESCRIPTION,
    inputSchema: Schema,
    permission: (input, ctx) => {
      const skill = findModelSkill(runtime, input.name)
      if (skill === undefined || !isElevatingSkill(skill)) return null
      return {
        tool: "skill",
        callId: ctx.callId,
        title: `skill: ${skill.name}`,
        detail: skill.context === "fork" ? "runs in a subagent" : `grants: ${(skill.allowedTools ?? []).join(", ")}`,
        key: `skill:${skill.name}`,
        subject: skill.name,
      }
    },
    execute: async (input, ctx) => {
      const skill = findModelSkill(runtime, input.name)
      if (skill === undefined) {
        const names = modelSkillNames(runtime)
        return errorResult(`unknown skill: ${input.name}. Available skills: ${names.join(", ") || "(none)"}`)
      }
      if (skill.disableModelInvocation) {
        return errorResult(`skill ${skill.name} cannot be model-invoked; the user runs it with /${skill.name}`)
      }
      return runSkill(runtime, skill, input.args ?? "", ctx)
    },
  })
}

/** Execute a resolved skill: substitute its body, then run it inline or in a fork. */
async function runSkill(runtime: AgentRuntime, skill: Skill, args: string, ctx: ToolContext): Promise<ToolResult> {
  const body = substituteArgs(skill.body, {
    raw: args,
    skillDir: skill.dir,
    sessionId: ctx.sessionId,
    names: skill.arguments ?? [],
  })

  if (skill.context === "fork") {
    return runForkedSkill(runtime, skill, body, ctx)
  }

  if (skill.allowedTools !== undefined && skill.allowedTools.length > 0) {
    runtime.permissions.grantSkillTools(skill.allowedTools)
  }

  const files = skill.source === "disk" ? await sampleFiles(skill.dir) : []
  const output = renderInline(skill, body, files)
  return okResult(output, `skill: ${skill.name}`, { invokedSkill: { name: skill.name, body } })
}

function renderInline(skill: Skill, body: string, files: string[]): string {
  const parts = [body]
  if (skill.source === "disk") parts.push(`Base directory: ${skill.dir}`)
  if (files.length > 0) parts.push(`<skill_files>\n${files.join("\n")}\n</skill_files>`)
  return parts.join("\n\n")
}

function findModelSkill(runtime: AgentRuntime, name: string): Skill | undefined {
  return runtime.skills.find((skill) => skill.name === name)
}

function modelSkillNames(runtime: AgentRuntime): string[] {
  return runtime.skills
    .filter((skill) => !skill.disableModelInvocation && skill.description !== undefined)
    .map((skill) => skill.name)
}

async function sampleFiles(dir: string): Promise<string[]> {
  try {
    const glob = new Bun.Glob("**/*")
    const found: string[] = []
    for await (const rel of glob.scan({ cwd: dir, onlyFiles: true })) {
      if (rel === "SKILL.md") continue
      found.push(rel)
      if (found.length >= SAMPLE_SCAN_CAP) break
    }
    return found.sort((a, b) => a.localeCompare(b)).slice(0, MAX_SAMPLE_FILES)
  } catch {
    return []
  }
}
