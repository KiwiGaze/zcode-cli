import path from "node:path"
import { mkdir, readdir, stat, unlink } from "node:fs/promises"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"
import { z } from "zod"

export type MemoryType = "user" | "feedback" | "project" | "reference"

export interface MemoryEntry {
  name: string
  description: string
  type: MemoryType
  filename: string
  content: string
}

export type MemoryDraft = Omit<MemoryEntry, "filename">

export interface MemoryHeader {
  filename: string
  filePath: string
  mtimeMs: number
  description?: string
  type?: MemoryType
}

const MAX_INDEX_LINES = 200
const MAX_INDEX_BYTES = 25_000
const MAX_MEMORY_FILES = 200
export const MAX_MEMORY_BYTES_PER_FILE = 4096
export const MEMORY_INDEX_FILE = "MEMORY.md"
export const MEMORY_FILENAME_PATTERN = /^(user|feedback|project|reference)_[a-z0-9_]{1,40}\.md$/
const HEADER_SCAN_LINES = 30
const SLUG_MAX_LENGTH = 40
const UNNAMED_SLUG = "untitled"
const DAY_MS = 86_400_000

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/
const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const

const FrontmatterSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  type: z.enum(MEMORY_TYPES).optional(),
})

interface ParsedMemoryFile {
  name?: string
  description?: string
  type?: MemoryType
  body: string
}

/** Every memory file except the index, newest first, capped. */
async function memoryFiles(dir: string): Promise<{ filename: string; filePath: string; mtimeMs: number }[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const files: { filename: string; filePath: string; mtimeMs: number }[] = []
  for (const filename of names) {
    if (!filename.endsWith(".md") || filename === MEMORY_INDEX_FILE) continue
    const filePath = path.join(dir, filename)
    try {
      files.push({ filename, filePath, mtimeMs: (await stat(filePath)).mtimeMs })
    } catch {
      // skip a file that vanished between readdir and stat
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return files.slice(0, MAX_MEMORY_FILES)
}

function parseMemoryFile(raw: string): ParsedMemoryFile {
  const match = FRONTMATTER.exec(raw)
  const body = (match ? raw.slice(match[0].length) : raw).trim()
  const yamlText = match?.[1] ?? ""
  if (yamlText.trim().length === 0) return { body }

  const parsed = parseYaml(yamlText) as unknown
  if (parsed === null || parsed === undefined || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("frontmatter must be a mapping")
  }
  const result = FrontmatterSchema.safeParse(parsed)
  if (!result.success) throw new Error("invalid frontmatter")
  const data = result.data
  return {
    ...(data.name === undefined ? {} : { name: data.name }),
    ...(data.description === undefined ? {} : { description: data.description }),
    ...(data.type === undefined ? {} : { type: data.type }),
    body,
  }
}

/** Every well-formed memory, newest first. A corrupt file is skipped, never fatal. */
export async function listMemories(dir: string): Promise<MemoryEntry[]> {
  const entries: MemoryEntry[] = []
  for (const file of await memoryFiles(dir)) {
    try {
      const parsed = parseMemoryFile(await Bun.file(file.filePath).text())
      if (parsed.name === undefined || parsed.type === undefined) continue
      entries.push({
        name: parsed.name,
        description: parsed.description ?? "",
        type: parsed.type,
        filename: file.filename,
        content: parsed.body,
      })
    } catch {
      // skip corrupt file
    }
  }
  return entries
}

/**
 * Write one memory and rebuild the index. The filename is derived, never supplied, so a save can
 * not escape `dir` however hostile the name is.
 */
export async function saveMemory(dir: string, entry: MemoryDraft): Promise<string> {
  const filename = `${entry.type}_${slugify(entry.name)}.md`
  const front = stringifyYaml({ name: entry.name, description: entry.description, type: entry.type }).trimEnd()
  await mkdir(dir, { recursive: true })
  await Bun.write(path.join(dir, filename), `---\n${front}\n---\n${entry.content}\n`)
  await rebuildIndex(dir)
  return filename
}

/** Delete by filename. Rejects anything outside the derived-filename shape before touching disk. */
export async function deleteMemory(dir: string, filename: string): Promise<boolean> {
  if (!MEMORY_FILENAME_PATTERN.test(filename)) return false
  try {
    await unlink(path.join(dir, filename))
  } catch {
    return false
  }
  await rebuildIndex(dir)
  return true
}

/** The index as the model sees it, truncated to the documented caps. */
export async function loadMemoryIndex(dir: string): Promise<string> {
  let content: string
  try {
    content = await Bun.file(path.join(dir, MEMORY_INDEX_FILE)).text()
  } catch {
    return ""
  }
  const lines = content.split("\n")
  if (lines.length > MAX_INDEX_LINES) {
    content = `${lines.slice(0, MAX_INDEX_LINES).join("\n")}\n\n[... truncated, too many memory entries ...]`
  }
  if (Buffer.byteLength(content, "utf8") > MAX_INDEX_BYTES) {
    content = `${content.slice(0, MAX_INDEX_BYTES)}\n\n[... truncated, index too large ...]`
  }
  return content
}

/** Frontmatter-only scan for the recall selector: memory bodies stay out of the manifest. */
export async function scanMemoryHeaders(dir: string): Promise<MemoryHeader[]> {
  const headers: MemoryHeader[] = []
  for (const file of await memoryFiles(dir)) {
    try {
      const raw = await Bun.file(file.filePath).text()
      const parsed = parseMemoryFile(raw.split("\n").slice(0, HEADER_SCAN_LINES).join("\n"))
      headers.push({
        filename: file.filename,
        filePath: file.filePath,
        mtimeMs: file.mtimeMs,
        ...(parsed.description === undefined ? {} : { description: parsed.description }),
        ...(parsed.type === undefined ? {} : { type: parsed.type }),
      })
    } catch {
      // skip corrupt file
    }
  }
  return headers
}

export function formatMemoryManifest(headers: MemoryHeader[]): string {
  return headers
    .map((header) => {
      const tag = header.type === undefined ? "" : `[${header.type}] `
      const timestamp = new Date(header.mtimeMs).toISOString()
      const line = `- ${tag}${header.filename} (${timestamp})`
      return header.description === undefined ? line : `${line}: ${header.description}`
    })
    .join("\n")
}

export function memoryAge(mtimeMs: number): string {
  const days = daysOld(mtimeMs)
  if (days === 0) return "today"
  if (days === 1) return "yesterday"
  return `${days} days ago`
}

/** Non-empty for anything older than a day: stale memories are labeled, never silently trusted. */
export function memoryFreshnessWarning(mtimeMs: number): string {
  const days = daysOld(mtimeMs)
  if (days <= 1) return ""
  return (
    `This memory is ${days} days old. Memories are point-in-time observations, not live state — ` +
    "claims about code behavior may be outdated. Verify against current code before asserting as fact."
  )
}

/** The memory usage instructions plus the current index, for the session-context block. */
export function buildMemorySection(dir: string, index: string): string {
  return [
    "# Memory",
    `You have a persistent, file-based memory for this project at ${dir}.`,
    "",
    "## Types",
    "- **user**: the user's role, preferences, and expertise",
    "- **feedback**: corrections and guidance from the user (include why, and how to apply it)",
    "- **project**: ongoing work, goals, and decisions",
    "- **reference**: pointers to external resources (URLs, dashboards, tickets)",
    "",
    "## Saving",
    'Use the memory tool: `memory` with `operation: "save"` and a name, description, type, and content.',
    "It derives the filename and rebuilds the index — never write memory files by hand.",
    "",
    "## What not to save",
    "Code structure or patterns (read the code), git history, anything already in AGENTS.md or",
    "CLAUDE.md, and ephemeral task details.",
    "",
    index.length > 0 ? `## Current index\n${index}` : "(No memories saved yet.)",
  ].join("\n")
}

async function rebuildIndex(dir: string): Promise<void> {
  const memories = await listMemories(dir)
  const lines = ["# Memory index", ""]
  for (const memory of memories) {
    lines.push(`- **[${memory.name}](${memory.filename})** (${memory.type}) — ${memory.description}`)
  }
  await Bun.write(path.join(dir, MEMORY_INDEX_FILE), `${lines.join("\n")}\n`)
}

/**
 * Confine a model-supplied name to one path segment. An all-punctuation name slugifies to nothing,
 * which would produce a filename the delete pattern rejects, so it falls back to a fixed stem.
 */
function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/_+$/, "")
  return slug.length === 0 ? UNNAMED_SLUG : slug
}

function daysOld(mtimeMs: number): number {
  return Math.max(0, Math.floor((Date.now() - mtimeMs) / DAY_MS))
}
