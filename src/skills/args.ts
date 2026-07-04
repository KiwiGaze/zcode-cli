export interface SkillArgs {
  /** Raw argument text passed after the skill name. */
  raw: string
  skillDir: string
  sessionId: string
  /** Positional argument names from the `arguments` frontmatter, mapped to `$name`. */
  names: string[]
}

/**
 * Expand skill variables in a body: `$ARGUMENTS`, positional `$1`/`$2`, named `$name`
 * (from the `arguments` frontmatter), and `${SKILL_DIR}`/`${SESSION_ID}`. Unknown tokens
 * are left untouched so ordinary `$` text survives.
 */
export function substituteArgs(body: string, args: SkillArgs): string {
  const positional = args.raw.trim().length === 0 ? [] : args.raw.trim().split(/\s+/)
  const braces: Record<string, string> = { SKILL_DIR: args.skillDir, SESSION_ID: args.sessionId }

  const withBraces = body.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, key: string) => {
    const value = braces[key]
    return value === undefined ? whole : value
  })

  return withBraces.replace(/\$([A-Za-z0-9_]+)/g, (whole, token: string) => {
    if (token === "ARGUMENTS") return args.raw
    if (/^\d+$/.test(token)) return positional[Number(token) - 1] ?? ""
    const index = args.names.indexOf(token)
    if (index >= 0) return positional[index] ?? ""
    return whole
  })
}
