import { z } from "zod"
import { parseMarkdownFrontmatter } from "@/util/frontmatter"
import type { SkillContext } from "@/skills/types"

export interface ParsedSkillFile {
  /** Frontmatter `name` — overrides the display label only, never the invocation name. */
  displayName?: string
  description?: string
  whenToUse?: string
  allowedTools?: string[]
  context: SkillContext
  agent?: string
  model?: string
  argumentHint?: string
  arguments?: string[]
  userInvocable: boolean
  disableModelInvocation: boolean
  paths?: string[]
  body: string
}

const stringList = z
  .union([z.string(), z.array(z.string())])
  .transform((value) => (typeof value === "string" ? [value] : value))

const FrontmatterSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  whenToUse: z.string().optional(),
  allowedTools: stringList.optional(),
  context: z.enum(["inline", "fork"]).optional(),
  agent: z.string().optional(),
  model: z.string().optional(),
  argumentHint: z.string().optional(),
  arguments: stringList.optional(),
  userInvocable: z.boolean().optional(),
  disableModelInvocation: z.boolean().optional(),
  paths: stringList.optional(),
})

const ALIASES: Record<string, string> = {
  when_to_use: "whenToUse",
  "allowed-tools": "allowedTools",
  "argument-hint": "argumentHint",
  "user-invocable": "userInvocable",
  "disable-model-invocation": "disableModelInvocation",
}

/** Parse a SKILL.md string into normalized frontmatter fields plus the body. Throws on invalid types. */
export function parseSkillFile(raw: string): ParsedSkillFile {
  const { front, body } = parseMarkdownFrontmatter(raw, ALIASES)

  const result = FrontmatterSchema.safeParse(front)
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ")
    throw new Error(`invalid frontmatter: ${issues}`)
  }
  const data = result.data

  return {
    ...(data.name === undefined ? {} : { displayName: data.name }),
    ...(data.description === undefined ? {} : { description: data.description }),
    ...(data.whenToUse === undefined ? {} : { whenToUse: data.whenToUse }),
    ...(data.allowedTools === undefined ? {} : { allowedTools: data.allowedTools }),
    context: data.context ?? "inline",
    ...(data.agent === undefined ? {} : { agent: data.agent }),
    ...(data.model === undefined ? {} : { model: data.model }),
    ...(data.argumentHint === undefined ? {} : { argumentHint: data.argumentHint }),
    ...(data.arguments === undefined ? {} : { arguments: data.arguments }),
    userInvocable: data.userInvocable ?? true,
    disableModelInvocation: data.disableModelInvocation ?? false,
    ...(data.paths === undefined ? {} : { paths: data.paths }),
    body,
  }
}

