export type SkillContext = "inline" | "fork"
export type SkillSource = "disk" | "bundled"

export interface Skill {
  /** Directory name; the unique invocation name. A frontmatter `name` only overrides the display label. */
  name: string
  /** Shown in the model catalog. Absent → the skill is not advertised (still loadable by explicit name). */
  description?: string
  /** `when_to_use` frontmatter; appended to the catalog line as a usage hint. */
  whenToUse?: string
  /** Tool patterns temporarily granted while the skill runs, e.g. `"bash"`, `"bash(gh:*)"`, `"write"`. */
  allowedTools?: string[]
  /** How the body runs: injected into the current turn (`inline`) or in a subagent (`fork`). */
  context: SkillContext
  /** Fork subagent label (informational). */
  agent?: string
  /** Model override for a forked skill. */
  model?: string
  /** Slash-menu hint describing expected arguments. */
  argumentHint?: string
  /** Positional argument names, mapped to `$1`/`$name` during substitution. */
  arguments?: string[]
  /** False → no `/name` slash command is offered. Default true. */
  userInvocable: boolean
  /** True → excluded from the model catalog; only reachable via `/name`. Default false. */
  disableModelInvocation: boolean
  /** Conditional-activation globs; the skill enters the catalog only after a matching file is touched. */
  paths?: string[]
  source: SkillSource
  /** Absolute path of the skill directory (so the body can reference bundled scripts/references). */
  dir: string
  /** Absolute path of SKILL.md; `"<bundled>"` for built-in skills. */
  location: string
  /** The Markdown body with frontmatter stripped. */
  body: string
}
