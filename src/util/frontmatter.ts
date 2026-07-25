import { parse as parseYaml } from "yaml"
import type { z } from "zod"

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

export interface MarkdownFrontmatter {
  front: Record<string, unknown>
  body: string
}

/**
 * Split a markdown file into its YAML frontmatter mapping and body. `aliases` renames on-disk keys
 * to the schema's names, so `allowed-tools` and `allowedTools` both land in one field. Throws when
 * frontmatter is present but is not a mapping.
 */
export function parseMarkdownFrontmatter(raw: string, aliases: Record<string, string> = {}): MarkdownFrontmatter {
  const match = FRONTMATTER.exec(raw)
  const body = (match ? raw.slice(match[0].length) : raw).trim()
  const yamlText = match?.[1] ?? ""
  if (yamlText.trim().length === 0) return { front: {}, body }

  const parsed = parseYaml(yamlText) as unknown
  if (parsed === null || parsed === undefined) return { front: {}, body }
  if (typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("frontmatter must be a mapping")

  const front: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    front[aliases[key] ?? key] = value
  }
  return { front, body }
}

/** A schema failure as one line naming each bad field, for the warning a skipped file produces. */
export function frontmatterError(error: z.ZodError): Error {
  const issues = error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")
  return new Error(`invalid frontmatter: ${issues}`)
}
