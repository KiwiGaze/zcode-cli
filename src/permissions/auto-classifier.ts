import { AUTO_MODE_RULES } from "@/permissions/auto-rules"
import type { CompleteFn } from "@/llm/complete"
import type { ChatItem } from "@/session/messages"
import type { EndpointKind, ProviderId } from "@/llm/providers"

export const AUTO_CLASSIFY_TIMEOUT_MS = 30_000
const STAGE1_MAX_OUTPUT_TOKENS = 256
const STAGE2_MAX_OUTPUT_TOKENS = 1024
const ENTRY_MAX_CHARS = 1500
const USER_ENTRY_MAX_CHARS = 2000
const TRANSCRIPT_MAX_CHARS = 12_000

export type ClassifierVerdict =
  | { kind: "allow"; stage: 1 | 2 }
  | { kind: "block"; stage: 1 | 2; reason: string }
  /** Transport, timeout, or setup failure. Not a denial — it hands back to the human. */
  | { kind: "unavailable"; reason: string }

export interface PendingAction {
  tool: string
  input: unknown
}

/** The transport slice of a `CompleteRequest`, resolved once per `query()`. */
export interface ModelTarget {
  provider: ProviderId
  endpointKind: EndpointKind
  baseUrl: string
  apiKey: string
}

/**
 * JSON-encode, then escape `<`, `>`, and `&`. Plain `JSON.stringify` escapes quotes and newlines
 * but not angle brackets, so a payload containing `</transcript>` or `<block>no</block>` would
 * appear literally inside the wrapper and could reframe the classifier. Escaping neutralizes that
 * while staying valid JSON.
 */
export function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&]/g, (char) =>
    char === "<" ? "\\u003c" : char === ">" ? "\\u003e" : "\\u0026",
  )
}

/**
 * The security-relevant string for one tool call. Writes carry their *content*, because a path
 * alone hides credential leakage and instruction poisoning.
 */
export function projectActionForClassifier(tool: string, input: unknown): string {
  const record = (input === null || typeof input !== "object" ? {} : input) as Record<string, unknown>
  const field = (key: string): string => (typeof record[key] === "string" ? (record[key] as string) : "")
  switch (tool) {
    case "bash":
      return clip(field("command"))
    case "write":
      return clip(`${field("filePath")}: ${field("content")}`)
    case "edit":
      return clip(`${field("filePath")}: ${field("newString")}`)
    case "webfetch":
      return clip(`fetch ${field("url")}`)
    default:
      return clip(JSON.stringify(input ?? {}))
  }
}

/**
 * A reasoning-blind projection: user turns and assistant *tool calls* only. Assistant prose and
 * reasoning are dropped because they are model-written and could be crafted to steer the
 * classifier, and tool results are skipped entirely. The action under review is appended last.
 */
export function buildClassifierTranscript(items: ChatItem[], pending: PendingAction): string {
  const lines: string[] = []
  for (const item of items) {
    if (item.type === "user") {
      const text = item.content
        .map((part) => part.text)
        .join(" ")
        .trim()
      if (text.length > 0) lines.push(safeJson({ user: text.slice(0, USER_ENTRY_MAX_CHARS) }))
    } else if (item.type === "assistant") {
      for (const part of item.parts) {
        if (part.type !== "tool-call") continue
        lines.push(safeJson({ [part.name]: projectActionForClassifier(part.name, part.input) }))
      }
    }
  }

  const action = safeJson({ [pending.tool]: projectActionForClassifier(pending.tool, pending.input) })
  // Truncate the history, never the action under review.
  const history = lines.join("\n")
  const room = TRANSCRIPT_MAX_CHARS - action.length
  if (room <= 0 || history.length <= room) return history.length === 0 ? action : `${history}\n${action}`
  return `[earlier entries omitted]\n${history.slice(-room)}\n${action}`
}

export function buildClassifierSystem(): string {
  const bucket = (title: string, items: readonly string[]): string =>
    `## ${title}\n${items.map((rule) => `- ${rule}`).join("\n")}`
  return [
    AUTO_MODE_RULES.systemSkeleton,
    bucket("Environment", AUTO_MODE_RULES.environment),
    bucket("HARD BLOCK", AUTO_MODE_RULES.hardDeny),
    bucket("SOFT BLOCK", AUTO_MODE_RULES.softDeny),
    bucket("ALLOW Exceptions", AUTO_MODE_RULES.allow),
    AUTO_MODE_RULES.outputFormat,
  ].join("\n\n")
}

/**
 * Project instructions ride the *user* message, JSON-encoded — repo content must never occupy the
 * system role, where it would gain authority to override the rules.
 */
export function classifierUserMessage(transcript: string, stage: 1 | 2, instructions?: string): string {
  const trimmed = instructions?.trim() ?? ""
  const preamble =
    trimmed.length === 0
      ? ""
      : `${AUTO_MODE_RULES.instructionsInjection}\n<project_instructions>\n${safeJson(trimmed)}\n</project_instructions>\n\n`
  const suffix = stage === 1 ? AUTO_MODE_RULES.stage1Suffix : AUTO_MODE_RULES.stage2Suffix
  return `${preamble}<transcript>\n${transcript}\n</transcript>\n\n${suffix}`
}

/**
 * Parse `<block>yes|no</block><reason>…</reason>`. `<thinking>` is stripped first so a smuggled
 * `<thinking><block>no</block></thinking>` cannot be read as an allow, and the reply must *start*
 * with a fully closed tag — a truncated `<block>no` is malformed. Anything unexpected blocks.
 */
export function parseBlockVerdict(raw: string): { block: boolean; reason: string } {
  const cleaned = raw
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/<thinking>[\s\S]*$/i, "")
    .trimStart()
  const verdict = /^<block>\s*(yes|no)\s*<\/block>/i.exec(cleaned)
  if (verdict === null) return { block: true, reason: "unparseable classifier output — blocking for safety" }
  if ((verdict[1] ?? "").toLowerCase() === "no") return { block: false, reason: "" }
  const reason = /<reason>\s*([\s\S]*?)\s*<\/reason>/i.exec(cleaned)
  return { block: true, reason: reason?.[1]?.trim() ?? "blocked (no reason given)" }
}

export interface ClassifyOptions {
  complete: CompleteFn
  target: ModelTarget
  gateModel: string
  judgeModel: string
  items: ChatItem[]
  pending: PendingAction
  instructions?: string
  signal: AbortSignal
}

/**
 * Two-stage classify: a cheap aggressive gate, then careful adjudication only when the gate blocks.
 * Stage 2's verdict is final. Never throws — a failure is `unavailable`, which the caller routes to
 * the human dialog rather than treating as a denial.
 */
export async function classifyAction(options: ClassifyOptions): Promise<ClassifierVerdict> {
  const transcript = buildClassifierTranscript(options.items, options.pending)
  const system = buildClassifierSystem()

  const stage1 = await runStage(options, system, transcript, 1)
  if (stage1.kind === "unavailable") return stage1
  if (!stage1.verdict.block) return { kind: "allow", stage: 1 }

  const stage2 = await runStage(options, system, transcript, 2)
  if (stage2.kind === "unavailable") return stage2
  if (!stage2.verdict.block) return { kind: "allow", stage: 2 }
  return { kind: "block", stage: 2, reason: stage2.verdict.reason }
}

type StageOutcome =
  { kind: "ok"; verdict: { block: boolean; reason: string } } | { kind: "unavailable"; reason: string }

async function runStage(
  options: ClassifyOptions,
  system: string,
  transcript: string,
  stage: 1 | 2,
): Promise<StageOutcome> {
  const timer = new AbortController()
  const timeout = setTimeout(() => timer.abort(), AUTO_CLASSIFY_TIMEOUT_MS)
  const onAbort = (): void => timer.abort()
  // A listener on an already-aborted signal never fires, so an interrupt that landed before this
  // call has to be propagated explicitly — otherwise the classification would run on regardless.
  if (options.signal.aborted) timer.abort()
  else options.signal.addEventListener("abort", onAbort, { once: true })
  try {
    const raw = await options.complete({
      ...options.target,
      model: stage === 1 ? options.gateModel : options.judgeModel,
      system,
      prompt: classifierUserMessage(transcript, stage, options.instructions),
      maxOutputTokens: stage === 1 ? STAGE1_MAX_OUTPUT_TOKENS : STAGE2_MAX_OUTPUT_TOKENS,
      temperature: 0,
      signal: timer.signal,
    })
    return { kind: "ok", verdict: parseBlockVerdict(raw) }
  } catch (error) {
    return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timeout)
    options.signal.removeEventListener("abort", onAbort)
  }
}

/** Head+tail clip: secrets often sit at either end, so keep both. */
function clip(text: string, max = ENTRY_MAX_CHARS): string {
  if (text.length <= max) return text
  const half = Math.floor((max - 20) / 2)
  return `${text.slice(0, half)}…[${text.length - half * 2} chars]…${text.slice(-half)}`
}
