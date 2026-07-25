import type { ResolvedConfig } from "@/config/config"
import { complete as defaultComplete, type CompleteFn } from "@/llm/complete"
import { baseUrl, requireApiKey } from "@/llm/providers"
import { truncateToBytes } from "@/util/text"
import {
  buildMemorySection,
  formatMemoryManifest,
  loadMemoryIndex,
  memoryAge,
  memoryFreshnessWarning,
  scanMemoryHeaders,
  MAX_MEMORY_BYTES_PER_FILE,
  type MemoryHeader,
} from "@/memory/store"

const SELECTOR_SYSTEM = `You are selecting memories that will be useful to a CLI coding agent as it
processes a user's query. You will be given the user's query and a list of available memory files
with their filenames and descriptions.

Return a JSON object with a "selected_memories" array of filenames for the memories that will
clearly be useful (up to 5). Only include memories that you are certain will be helpful based on
their name and description.
- If you are unsure whether a memory will be useful, do not include it.
- If no memories would clearly be useful, return an empty array.`

const SELECTOR_MAX_OUTPUT_TOKENS = 256
const MAX_SELECTED = 5
const MIN_CJK_CHARS = 2
const CJK = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g
const JSON_OBJECT = /\{[\s\S]*\}/
const NAME_PREFIX = /^(user|feedback|project|reference)_/

export interface RelevantMemory {
  path: string
  name: string
  content: string
  header: string
}

export interface MemorySession {
  /**
   * Non-blocking. Drains the previous turn's settled recall into the ready slot, then starts a new
   * prefetch when the gates pass.
   */
  beginTurn(prompt: string, signal: AbortSignal): void
  /** Synchronous and zero-await. Returns the formatted injection once per settled recall. */
  pollInjection(): { text: string; names: string[] } | null
  /** Memory usage instructions plus the current index; "" when disabled. */
  promptSection(): Promise<string>
  setConfig(config: ResolvedConfig): void
  /** Clears surfaced paths and the byte budget; called on session resume. */
  reset(): void
}

export interface MemorySessionOptions {
  config: ResolvedConfig
  dir: string
  complete?: CompleteFn
}

interface Prefetch {
  settled: boolean
  consumed: boolean
  value: RelevantMemory[]
}

export function createMemorySession(options: MemorySessionOptions): MemorySession {
  const { dir } = options
  const complete = options.complete ?? defaultComplete
  const surfaced = new Set<string>()
  let config = options.config
  let sessionBytes = 0
  let ready: RelevantMemory[] | null = null
  let pending: Prefetch | null = null

  /** Drain the ready slot first, then a settled prefetch. Each recall is taken at most once. */
  const take = (): RelevantMemory[] | null => {
    if (ready !== null) {
      const value = ready
      ready = null
      return value
    }
    if (pending !== null && pending.settled && !pending.consumed) {
      pending.consumed = true
      return pending.value
    }
    return null
  }

  return {
    beginTurn(prompt, signal) {
      if (!config.memory.enabled) return
      if (pending !== null && pending.settled && !pending.consumed) {
        pending.consumed = true
        ready = pending.value
      }
      pending = null
      if (!isQuerySubstantial(prompt)) return
      if (sessionBytes >= config.memory.sessionBudgetBytes) return

      const handle: Prefetch = { settled: false, consumed: false, value: [] }
      pending = handle
      void selectRelevantMemories({ dir, config, complete, query: prompt, alreadySurfaced: surfaced, signal })
        .then((memories) => {
          handle.value = memories
        })
        .catch(() => {
          // Recall must never surface in the UI or fail the turn; an empty result is the failure mode.
        })
        .finally(() => {
          handle.settled = true
        })
    },

    pollInjection() {
      const drained = take()
      if (drained === null) return null
      // A prefetch filters by the surfaced set as it *starts*; a carried-over recall can therefore
      // overlap one started later in the same turn. Filtering again here is what makes
      // "surfaced at most once per session" hold rather than merely usually hold.
      const memories = drained.filter((memory) => !surfaced.has(memory.path))
      if (memories.length === 0) return null
      for (const memory of memories) {
        surfaced.add(memory.path)
        sessionBytes += Buffer.byteLength(memory.content, "utf8")
      }
      return { text: formatMemoriesForInjection(memories), names: memories.map((memory) => memory.name) }
    },

    async promptSection() {
      if (!config.memory.enabled) return ""
      return buildMemorySection(dir, await loadMemoryIndex(dir))
    },

    setConfig(next) {
      config = next
    },

    reset() {
      surfaced.clear()
      sessionBytes = 0
      ready = null
      pending = null
    },
  }
}

/** Enough content to be worth a side call: two or more CJK characters, or more than one word. */
export function isQuerySubstantial(query: string): boolean {
  const trimmed = query.trim()
  if (trimmed.length === 0) return false
  const cjk = trimmed.match(CJK)
  if (cjk !== null && cjk.length >= MIN_CJK_CHARS) return true
  return /\s/.test(trimmed)
}

export interface SelectMemoriesInput {
  dir: string
  config: ResolvedConfig
  complete: CompleteFn
  query: string
  alreadySurfaced: ReadonlySet<string>
  signal: AbortSignal
}

/**
 * Ask the model which memories matter for this query. The selector sees frontmatter metadata only;
 * bodies are read after selection, capped per file and labeled with their freshness.
 */
export async function selectRelevantMemories(input: SelectMemoriesInput): Promise<RelevantMemory[]> {
  const headers = await scanMemoryHeaders(input.dir)
  const candidates = headers.filter((header) => !input.alreadySurfaced.has(header.filePath))
  if (candidates.length === 0) return []

  const manifest = formatMemoryManifest(candidates)
  const text = await input.complete({
    provider: input.config.provider,
    model: input.config.model,
    endpointKind: input.config.endpointKind,
    baseUrl: baseUrl(input.config.provider, input.config.endpointKind),
    apiKey: requireApiKey(input.config.provider, input.config),
    system: SELECTOR_SYSTEM,
    prompt: `Query: ${input.query}\n\nAvailable memories:\n${manifest}`,
    maxOutputTokens: SELECTOR_MAX_OUTPUT_TOKENS,
    temperature: 0,
    signal: input.signal,
  })

  const chosen = parseSelection(text)
  if (chosen.size === 0) return []
  const selected = candidates.filter((header) => chosen.has(header.filename)).slice(0, MAX_SELECTED)

  const memories: RelevantMemory[] = []
  for (const header of selected) {
    const content = await readCapped(header.filePath)
    if (content === null) continue
    memories.push({
      path: header.filePath,
      name: memoryName(header.filename),
      content,
      header: freshnessHeader(header),
    })
  }
  return memories
}

export function formatMemoriesForInjection(memories: RelevantMemory[]): string {
  return memories
    .map((memory) => `<system-reminder>\n${memory.header}\n\n${memory.content}\n</system-reminder>`)
    .join("\n\n")
}

/** Filenames the model chose. Tolerates fences and prose around the JSON; junk yields nothing. */
function parseSelection(text: string): Set<string> {
  const match = JSON_OBJECT.exec(text)
  if (match === null) return new Set()
  let parsed: unknown
  try {
    parsed = JSON.parse(match[0])
  } catch {
    return new Set()
  }
  if (parsed === null || typeof parsed !== "object") return new Set()
  const selected = (parsed as Record<string, unknown>)["selected_memories"]
  if (!Array.isArray(selected)) return new Set()
  return new Set(selected.filter((value): value is string => typeof value === "string"))
}

async function readCapped(filePath: string): Promise<string | null> {
  let content: string
  try {
    content = await Bun.file(filePath).text()
  } catch {
    return null
  }
  if (Buffer.byteLength(content, "utf8") <= MAX_MEMORY_BYTES_PER_FILE) return content
  return `${truncateToBytes(content, MAX_MEMORY_BYTES_PER_FILE)}\n\n[... truncated, memory file too large ...]`
}

function freshnessHeader(header: MemoryHeader): string {
  const warning = memoryFreshnessWarning(header.mtimeMs)
  if (warning.length > 0) return `${warning}\n\nMemory: ${header.filePath}:`
  return `Memory (saved ${memoryAge(header.mtimeMs)}): ${header.filePath}:`
}

function memoryName(filename: string): string {
  return filename.replace(NAME_PREFIX, "").replace(/\.md$/, "")
}
