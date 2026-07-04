import type { ResolvedConfig } from "@/config/config"
import { modelInfo } from "@/config/config"
import { baseUrl, requireApiKey } from "@/llm/providers"
import { streamLLM } from "@/llm/stream"
import type { LLMStreamFn } from "@/llm/types"
import { assistantText, userMessage, type ChatItem } from "@/session/messages"
import type { Session } from "@/session/session"
import type { CompactionRecord } from "@/session/store"
import { newId } from "@/util/id"

const COMPACTION_SYSTEM = `You are a context-summarization assistant for a coding session.

Summarize only the conversation history you are given. The newest turns are kept verbatim
outside your summary, so focus on older context that still matters for continuing the work.
If a <previous-summary> block is present, treat it as the current summary and update it:
keep still-true facts, drop stale ones, merge in new facts.

Preserve exact file paths, identifiers, and commands. Prefer terse bullets over prose.
Do not answer the conversation itself and do not mention that you are summarizing.`

const STRUCTURE = `Produce these sections:
## Goal
## Key decisions
## Files touched
## Current state
## Next steps`

const CHARS_PER_TOKEN = 4
const KEEP_RECENT_USER_TURNS = 1

export interface CompactionDeps {
  llm?: LLMStreamFn
}

/** Messages actually sent to the model, folding history at the latest compaction record. */
export function projectForModel(session: Session, compactions: CompactionRecord[]): ChatItem[] {
  const latest = compactions[compactions.length - 1]
  if (latest === undefined) return session.items
  const cutoff = indexOfMessage(session.items, latest.coversUpTo)
  if (cutoff < 0) return session.items
  const tail = session.items.slice(cutoff + 1)
  const summary = userMessage(newId("msg"), `<conversation-summary>\n${latest.summary}\n</conversation-summary>`)
  return [summary, ...tail]
}

function indexOfMessage(items: ChatItem[], id: string): number {
  return items.findIndex((item) => (item.type === "user" || item.type === "assistant") && item.id === id)
}

export function contextWindow(config: ResolvedConfig): number {
  return modelInfo(config, config.model)?.context ?? 128_000
}

export function estimatePromptTokens(items: ChatItem[]): number {
  let chars = 0
  for (const item of items) {
    if (item.type === "user") chars += item.content.reduce((sum, part) => sum + part.text.length, 0)
    else if (item.type === "assistant") chars += item.parts.reduce((sum, part) => sum + partLength(part), 0)
    else chars += item.result.output.length
  }
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

function partLength(part: { type: string; text?: string; input?: unknown }): number {
  if (part.type === "text" || part.type === "reasoning") return part.text?.length ?? 0
  return JSON.stringify(part.input ?? {}).length
}

/** The prompt token count of the most recent request, from real usage when available. */
export function lastPromptTokens(session: Session, compactions: CompactionRecord[]): number {
  for (let i = session.items.length - 1; i >= 0; i--) {
    const item = session.items[i]
    if (item?.type === "assistant" && item.usage.input > 0) return item.usage.input
  }
  return estimatePromptTokens(projectForModel(session, compactions))
}

export function shouldCompact(session: Session, config: ResolvedConfig, compactions: CompactionRecord[]): boolean {
  const window = contextWindow(config)
  const used = lastPromptTokens(session, compactions)
  return used > window * config.compaction.threshold
}

function splitIndex(items: ChatItem[]): number {
  const userIndexes: number[] = []
  for (let i = 0; i < items.length; i++) if (items[i]?.type === "user") userIndexes.push(i)
  if (userIndexes.length <= KEEP_RECENT_USER_TURNS) return -1
  return userIndexes[userIndexes.length - KEEP_RECENT_USER_TURNS] ?? -1
}

export async function compact(
  session: Session,
  config: ResolvedConfig,
  compactions: CompactionRecord[],
  signal: AbortSignal,
  deps?: CompactionDeps,
): Promise<CompactionRecord | null> {
  const projected = projectForModel(session, compactions)
  const split = splitIndex(projected)
  if (split <= 0) return null

  const older = projected.slice(0, split)
  const coverId = lastMessageId(older)
  if (coverId === undefined) return null

  const previous = compactions[compactions.length - 1]
  const transcript = renderTranscript(older)
  const userPrompt = [
    previous ? `<previous-summary>\n${previous.summary}\n</previous-summary>\n` : "",
    "Summarize the conversation below so work can continue after older turns are dropped.",
    STRUCTURE,
    "",
    "<conversation>",
    transcript,
    "</conversation>",
  ]
    .filter((line) => line.length > 0)
    .join("\n")

  const llm = deps?.llm ?? streamLLM
  let summary = ""
  const stream = llm({
    provider: config.provider,
    model: config.model,
    endpointKind: config.endpointKind,
    baseUrl: baseUrl(config.provider, config.endpointKind),
    apiKey: requireApiKey(config.provider, config),
    system: COMPACTION_SYSTEM,
    messages: [userMessage(newId("msg"), userPrompt)],
    tools: [],
    maxOutputTokens: 4096,
    signal,
  })
  for await (const event of stream) {
    if (event.type === "text-delta") summary += event.text
  }
  summary = summary.trim()
  if (summary.length === 0) return null

  const record: CompactionRecord = { type: "compaction", summary, coversUpTo: coverId }
  compactions.push(record)
  return record
}

function lastMessageId(items: ChatItem[]): string | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item?.type === "user" || item?.type === "assistant") return item.id
  }
  return undefined
}

function renderTranscript(items: ChatItem[]): string {
  const lines: string[] = []
  for (const item of items) {
    if (item.type === "user") {
      lines.push(`USER: ${item.content.map((part) => part.text).join("")}`)
    } else if (item.type === "assistant") {
      const text = assistantText(item)
      if (text.length > 0) lines.push(`ASSISTANT: ${text}`)
      for (const part of item.parts) {
        if (part.type === "tool-call") lines.push(`ASSISTANT called ${part.name}(${JSON.stringify(part.input)})`)
      }
    } else {
      lines.push(`TOOL ${item.name} -> ${item.result.output.slice(0, 500)}`)
    }
  }
  return lines.join("\n")
}
