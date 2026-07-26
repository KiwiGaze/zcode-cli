import type { InstructionFile } from "@/agent/instructions"
import { formatSkillCatalog } from "@/skills/catalog"
import type { Skill } from "@/skills/types"
import type { ChatItem, UserMessage } from "@/session/messages"

const PLAN_MODE = `# Plan mode
You are in plan mode. Do NOT edit files, write files, or run shell commands — those tools are
blocked and will be rejected. Investigate using read-only tools, then present a concise,
step-by-step plan and wait for the user to approve it before making any changes.`

export interface SessionContextInput {
  /** Working directory presented to the model. */
  readonly cwd: string
  /** Runtime platform identifier presented to the model. */
  readonly platform: string
  /** Runtime platform release presented to the model. */
  readonly platformRelease: string
  /** Human-readable request date presented to the model. */
  readonly date: string
  /** Maximum rendered skill catalog length. */
  readonly skillCatalogBudgetChars: number
  /** Project instruction files active for this session. */
  readonly instructions: readonly InstructionFile[]
  /** Whether mutating tools are blocked for plan mode. */
  readonly planMode: boolean
  /** Skills available to the session. */
  readonly skills: readonly Skill[]
  /** Absolute paths touched during the session. */
  readonly activePaths: readonly string[]
  /** Memory usage instructions and index; "" when memory is off or empty. */
  readonly memorySection?: string
}

/** Build deterministic per-session context from the supplied environment and runtime snapshot. */
export function buildSessionContext(input: SessionContextInput): string {
  const parts = [environmentSection(input)]
  if (input.planMode) parts.push(PLAN_MODE)
  if (input.instructions.length > 0) parts.push(instructionsSection(input.instructions))
  const catalog = formatSkillCatalog(input.skills, {
    budgetChars: input.skillCatalogBudgetChars,
    activePaths: input.activePaths,
  })
  if (catalog.length > 0) parts.push(catalog)
  const memory = input.memorySection ?? ""
  if (memory.length > 0) parts.push(memory)
  return ["<system-reminder>", parts.join("\n\n"), "</system-reminder>"].join("\n")
}

/** Prepend context to the first user item without mutating the input array or its items. */
export function withSessionContext(items: ChatItem[], context: string): ChatItem[] {
  if (context.length === 0) return items

  const userIndex = items.findIndex((item) => item.type === "user")
  if (userIndex < 0) return items

  const userItem = items[userIndex]! as UserMessage
  const projected = items.slice()
  projected[userIndex] = {
    ...userItem,
    content: [{ type: "text", text: `${context}\n\n` }, ...userItem.content],
  }
  return projected
}

function environmentSection(input: SessionContextInput): string {
  return [
    "# Environment",
    `Working directory: ${input.cwd}`,
    `Platform: ${input.platform} (${input.platformRelease})`,
    `Date: ${input.date}`,
  ].join("\n")
}

/** Project instruction files as one prompt block. Shared with the subagent prompt, which frames
 *  project rules the same way the parent's session context does. */
export function instructionsSection(instructions: readonly InstructionFile[]): string {
  const blocks = instructions.map((file) => `# From ${file.path}\n${file.content}`)
  return ["# Project instructions", "Follow these project-specific rules:", "", blocks.join("\n\n")].join("\n")
}
