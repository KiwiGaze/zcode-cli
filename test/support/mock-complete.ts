import type { CompleteFn, CompleteRequest } from "@/llm/complete"
import type { TokenUsage } from "@/session/messages"

export interface MockComplete {
  fn: CompleteFn
  calls: CompleteRequest[]
}

/**
 * Replays scripted completion replies. The last reply repeats once the script runs out, so a test
 * can drive many actions from one entry. An `Error` entry is thrown instead of returned.
 */
export function mockComplete(replies: (string | Error)[], usage?: TokenUsage): MockComplete {
  const calls: CompleteRequest[] = []
  let index = 0
  const fn: CompleteFn = async (request) => {
    calls.push(request)
    if (usage !== undefined) request.onUsage?.({ model: request.model, usage })
    const reply = replies[Math.min(index, replies.length - 1)]
    index += 1
    if (reply instanceof Error) throw reply
    return reply ?? ""
  }
  return { fn, calls }
}
