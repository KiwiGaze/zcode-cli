import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import type { ResolvedConfig } from "@/config/config"
import { sessionDir } from "@/config/paths"
import type { Session } from "@/session/session"
import type { ToolResult } from "@/tools/types"

/** Where a large tool result was written, carried on `ToolResult.metadata.spill`. */
export interface SpillInfo {
  path: string
  bytes: number
  lines: number
}

const SPILL_KEY = "spill"
const PREVIEW_MAX_BYTES = 8192

/**
 * Write an oversized tool output to a session-scoped file before the result enters history, leaving
 * a preview plus a `read` hint in its place. Returns the result unchanged when it is under the
 * threshold, did not succeed, spill is disabled, or the write failed.
 */
export async function spillToolResult(
  session: Session,
  callId: string,
  result: ToolResult,
  config: ResolvedConfig,
): Promise<ToolResult> {
  if (!config.spill.enabled || result.status !== "ok") return result
  const bytes = Buffer.byteLength(result.output, "utf8")
  if (bytes <= config.spill.thresholdBytes) return result

  const file = path.join(sessionDir(session.cwd), session.id, "tool-results", `${fileStem(callId)}.txt`)
  try {
    await mkdir(path.dirname(file), { recursive: true })
    await Bun.write(file, result.output)
  } catch {
    // A large prompt costs less than losing the output entirely.
    return result
  }

  const spill: SpillInfo = { path: file, bytes, lines: result.output.split("\n").length }
  return {
    ...result,
    output: replacement(spill, result.output, config.spill.previewLines),
    metadata: { ...result.metadata, [SPILL_KEY]: spill },
  }
}

/** The spill descriptor a tool result carries, or null when its output was never spilled. */
export function readSpillInfo(metadata: Record<string, unknown> | undefined): SpillInfo | null {
  const value = metadata?.[SPILL_KEY]
  if (value === null || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  const file = record["path"]
  const bytes = record["bytes"]
  const lines = record["lines"]
  if (typeof file !== "string" || typeof bytes !== "number" || typeof lines !== "number") return null
  return { path: file, bytes, lines }
}

function replacement(spill: SpillInfo, output: string, previewLines: number): string {
  const size = (spill.bytes / 1024).toFixed(1)
  const preview = capBytes(output.split("\n").slice(0, previewLines).join("\n"), PREVIEW_MAX_BYTES)
  return [
    `[Result too large (${size} KB, ${spill.lines} lines). Full output saved to ${spill.path}. ` +
      `Use the read tool with filePath="${spill.path}" (offset/limit for pages) to retrieve more.]`,
    "",
    `Preview (first ${previewLines} lines):`,
    preview,
  ].join("\n")
}

/** Head+tail cap so one enormous line cannot smuggle the payload back into the prompt. */
function capBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text
  const half = Math.floor(maxBytes / 2)
  const head = headBytes(text, half)
  const tail = tailBytes(text, half)
  return `${head}\n[... preview truncated: ${text.length - head.length - tail.length} chars ...]\n${tail}`
}

function headBytes(text: string, maxBytes: number): string {
  let bytes = 0
  let end = 0
  for (const char of text) {
    bytes += Buffer.byteLength(char, "utf8")
    if (bytes > maxBytes) break
    end += char.length
  }
  return text.slice(0, end)
}

function tailBytes(text: string, maxBytes: number): string {
  const chars = [...text.slice(-maxBytes)]
  let bytes = 0
  let start = chars.length
  while (start > 0) {
    const size = Buffer.byteLength(chars[start - 1] ?? "", "utf8")
    if (bytes + size > maxBytes) break
    bytes += size
    start -= 1
  }
  return chars.slice(start).join("")
}

/**
 * A readable, path-safe stem for a model-generated call id. The digest of the raw id keeps ids that
 * sanitize to the same characters apart. 64 bits puts a collision out of reach for any real session
 * — a 50% chance needs roughly four billion spills sharing one sanitized prefix — not out of theory.
 */
function fileStem(callId: string): string {
  const safe = callId.replace(/[^a-zA-Z0-9-_]/g, "_")
  return `${safe}-${createHash("sha256").update(callId).digest("hex").slice(0, 16)}`
}
