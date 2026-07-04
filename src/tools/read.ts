import { z } from "zod"
import { stat, readdir, open } from "node:fs/promises"
import path from "node:path"
import { defineTool, type AnyTool } from "@/tools/registry"
import { okResult, errorResult } from "@/tools/types"
import { relativePath, resolvePath, looksBinaryByExtension, looksBinaryBySample } from "@/tools/fs-util"

const DEFAULT_LIMIT = 2000
const MAX_LINE_LENGTH = 2000
const MAX_BYTES = 50 * 1024
const SAMPLE_BYTES = 4096

import DESCRIPTION from "@/tools/prompts/read.txt"

const Schema = z.object({
  filePath: z.string().describe("The absolute path to the file or directory to read"),
  offset: z.number().int().min(0).optional().describe("The line number to start reading from (1-indexed)"),
  limit: z.number().int().min(1).optional().describe("The maximum number of lines to read (defaults to 2000)"),
})
type Input = z.infer<typeof Schema>

export const readTool: AnyTool = defineTool<Input>({
  name: "read",
  description: DESCRIPTION,
  inputSchema: Schema,
  permission: () => null,
  execute: async (input, ctx) => {
    const abs = resolvePath(ctx.cwd, input.filePath)
    let info
    try {
      info = await stat(abs)
    } catch {
      return errorResult(`File not found: ${abs}`)
    }

    if (info.isDirectory()) return readDirectory(abs, input, ctx.cwd)

    if (looksBinaryByExtension(abs)) return errorResult(`Cannot read binary file: ${abs}`)
    const sample = await readSample(abs, Math.min(SAMPLE_BYTES, Number(info.size)))
    if (looksBinaryBySample(sample)) return errorResult(`Cannot read binary file: ${abs}`)

    const offset = input.offset ?? 1
    const limit = input.limit ?? DEFAULT_LIMIT
    const raw = await Bun.file(abs).text()
    const allLines = raw.split("\n")
    if (allLines.length > 0 && allLines[allLines.length - 1] === "") allLines.pop()
    const totalLines = allLines.length

    if (offset > totalLines && !(totalLines === 0 && offset === 1)) {
      return errorResult(`Offset ${offset} is out of range for this file (${totalLines} lines)`)
    }

    const start = offset - 1
    const selected = allLines.slice(start, start + limit)
    let bytes = 0
    const kept: string[] = []
    let capped = false
    for (const line of selected) {
      const clipped = line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}... (line truncated)` : line
      const size = Buffer.byteLength(clipped, "utf8") + (kept.length > 0 ? 1 : 0)
      if (bytes + size > MAX_BYTES) {
        capped = true
        break
      }
      kept.push(clipped)
      bytes += size
    }

    const last = offset + kept.length - 1
    const more = capped || start + kept.length < totalLines
    const body = kept.map((line, i) => `${i + offset}: ${line}`).join("\n")
    let footer: string
    if (capped) footer = `(Output capped at ${MAX_BYTES / 1024} KB. Showing lines ${offset}-${last}. Use offset=${last + 1} to continue.)`
    else if (more) footer = `(Showing lines ${offset}-${last} of ${totalLines}. Use offset=${last + 1} to continue.)`
    else footer = `(End of file - total ${totalLines} lines)`

    ctx.files.markRead(abs, info.mtimeMs)
    ctx.files.markTouched(abs)
    const output = `<path>${abs}</path>\n<content>\n${body}\n\n${footer}\n</content>`
    return okResult(output, relativePath(ctx.cwd, abs))
  },
})

async function readDirectory(abs: string, input: Input, cwd: string) {
  const entries = await readdir(abs, { withFileTypes: true })
  const names = await Promise.all(
    entries.map(async (entry) => {
      if (entry.isDirectory()) return `${entry.name}/`
      if (entry.isSymbolicLink()) {
        try {
          const target = await stat(path.join(abs, entry.name))
          if (target.isDirectory()) return `${entry.name}/`
        } catch {
          // dangling symlink — treat as file
        }
      }
      return entry.name
    }),
  )
  names.sort((a, b) => a.localeCompare(b))
  const offset = input.offset ?? 1
  const limit = input.limit ?? DEFAULT_LIMIT
  const start = offset - 1
  const sliced = names.slice(start, start + limit)
  const truncated = start + sliced.length < names.length
  const footer = truncated
    ? `\n(Showing ${sliced.length} of ${names.length} entries. Use offset=${offset + sliced.length} for more.)`
    : `\n(${names.length} entries)`
  const output = `<path>${abs}</path>\n<type>directory</type>\n<entries>\n${sliced.join("\n")}${footer}\n</entries>`
  return okResult(output, relativePath(cwd, abs))
}

async function readSample(abs: string, size: number): Promise<Uint8Array> {
  if (size <= 0) return new Uint8Array()
  const handle = await open(abs, "r")
  try {
    const buffer = new Uint8Array(size)
    const { bytesRead } = await handle.read(buffer, 0, size, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}
