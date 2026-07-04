import type { ChatItem, TokenUsage } from "@/session/messages"
import { EMPTY_USAGE } from "@/session/messages"
import { newId } from "@/util/id"

export interface Session {
  id: string
  cwd: string
  createdAt: number
  items: ChatItem[]
  /** Running total across all steps, for the status bar. */
  totalUsage: TokenUsage
  /** Inputs typed while the loop runs; merged at the next step boundary. */
  pendingInputs: string[]
}

export function createSession(cwd: string): Session {
  return {
    id: newId("ses"),
    cwd,
    createdAt: Date.now(),
    items: [],
    totalUsage: { ...EMPTY_USAGE },
    pendingInputs: [],
  }
}
