import { z } from "zod"
import { frontmatterError, parseMarkdownFrontmatter } from "@/util/frontmatter"

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
  // Parsed without aliases first, so the two grant keys are still distinguishable. Reading the
  // real top-level keys rather than line prefixes means neither a nested key that happens to be
  // called `tools` nor a flow-style mapping on one line can fool the check.
  const { front: declared, body } = parseMarkdownFrontmatter(raw)
  if ("tools" in declared && "allowed-tools" in declared) {
    throw new Error("frontmatter sets both 'tools' and 'allowed-tools'; keep one")
  }

  const front = Object.fromEntries(Object.entries(declared).map(([key, value]) => [ALIASES[key] ?? key, value]))
  const result = FrontmatterSchema.safeParse(front)
  if (!result.success) throw frontmatterError(result.error)
  const data = result.data

  return {
    ...(data.name === undefined ? {} : { displayName: data.name }),
    ...(data.description === undefined ? {} : { description: data.description }),
    ...(data.allowedTools === undefined ? {} : { allowedTools: data.allowedTools }),
    ...(data.model === undefined ? {} : { model: data.model }),
    body,
  }
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}
