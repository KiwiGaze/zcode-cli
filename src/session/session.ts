import type { ChatItem, TokenUsage } from "@/session/messages"
import { addUsage, EMPTY_USAGE } from "@/session/messages"
import { newId } from "@/util/id"

/** A skill body invoked inline, kept so compaction can re-inject it if the original is summarized away. */
export interface InvokedSkill {
  name: string
  body: string
  /** Id of the assistant message that invoked the skill, used to tell if it was folded into a summary. */
  itemId: string
}

export interface PendingInput {
  prompt: string
  label: string
  draft: string
}

export interface Session {
  id: string
  cwd: string
  createdAt: number
  items: ChatItem[]
  /** Running total across all steps, for the status bar. */
  totalUsage: TokenUsage
  /** Running totals keyed by the model that incurred them, for accurate cost accounting. */
  usageByModel: Record<string, TokenUsage>
  /** Inputs typed while the loop runs, consumed in FIFO order by the UI controller. */
  pendingInputs: PendingInput[]
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
    usageByModel: {},
    pendingInputs: [],
    invokedSkills: [],
  }
}

export function recordUsage(session: Session, model: string, usage: TokenUsage): void {
  session.totalUsage = addUsage(session.totalUsage, usage)
  session.usageByModel[model] = addUsage(session.usageByModel[model] ?? EMPTY_USAGE, usage)
}
