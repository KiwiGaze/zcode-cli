import type { CompleteFn, CompleteRequest } from "@/llm/complete"

export interface MockComplete {
  fn: CompleteFn
  calls: CompleteRequest[]
}

/**
 * Replays scripted classifier replies. The last reply repeats once the script runs out, so a test
 * can drive many actions from one entry. An `Error` entry is thrown instead of returned.
 */
export function mockComplete(replies: (string | Error)[]): MockComplete {
  const calls: CompleteRequest[] = []
  let index = 0
  const fn: CompleteFn = async (request) => {
    calls.push(request)
    const reply = replies[Math.min(index, replies.length - 1)]
    index += 1
    if (reply instanceof Error) throw reply
    return reply ?? ""
  }
  return { fn, calls }
}
