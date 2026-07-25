import { z } from "zod"
import { parseMarkdownFrontmatter } from "@/util/frontmatter"

export interface ParsedAgentFile {
  /** Frontmatter `name` — a display label only; the file stem is the invocation name. */
  displayName?: string
  description?: string
  allowedTools?: string[]
  model?: string
  body: string
}

const stringList = z
  .union([z.string(), z.array(z.string())])
  .transform((value) => (typeof value === "string" ? splitList(value) : value))

const FrontmatterSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  allowedTools: stringList.optional(),
  model: z.string().optional(),
})

/** Claude Code agent files spell the grant list `tools`; both map to one field. */
const ALIASES: Record<string, string> = {
  "allowed-tools": "allowedTools",
  tools: "allowedTools",
}

/**
 * Parse an agent markdown file. A file carrying both `tools` and `allowed-tools` is rejected rather
 * than silently resolved to one of them.
 */
export function parseAgentFile(raw: string): ParsedAgentFile {
  if (hasBothToolKeys(raw)) throw new Error("frontmatter sets both 'tools' and 'allowed-tools'; keep one")

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
    ...(data.allowedTools === undefined ? {} : { allowedTools: data.allowedTools }),
    ...(data.model === undefined ? {} : { model: data.model }),
    body,
  }
}

/** Checked on the raw frontmatter text, because aliasing collapses the two keys into one. */
function hasBothToolKeys(raw: string): boolean {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)
  if (match === null) return false
  const lines = match[1]?.split("\n") ?? []
  const keys = new Set(lines.map((line) => line.split(":")[0]?.trim()).filter((key) => key !== undefined))
  return keys.has("tools") && keys.has("allowed-tools")
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}
