import type { ChatItem, TokenUsage } from "@/session/messages"
import { EMPTY_USAGE } from "@/session/messages"
import { newId } from "@/util/id"

/** A skill body invoked inline, kept so compaction can re-inject it if the original is summarized away. */
export interface InvokedSkill {
  name: string
  body: string
  /** Id of the assistant message that invoked the skill, used to tell if it was folded into a summary. */
  itemId: string
}

export interface Session {
  id: string
  cwd: string
  createdAt: number
  items: ChatItem[]
  /** Running total across all steps, for the status bar. */
  totalUsage: TokenUsage
  /** Inputs typed while the loop runs; merged at the next step boundary. */
  pendingInputs: string[]
  /** Recently invoked inline skills, for compaction re-injection. */
  invokedSkills: InvokedSkill[]
}

export function createSession(cwd: string): Session {
  return {
    id: newId("ses"),
    cwd,
    createdAt: Date.now(),
    items: [],
    totalUsage: { ...EMPTY_USAGE },
    pendingInputs: [],
    invokedSkills: [],
  }
}
