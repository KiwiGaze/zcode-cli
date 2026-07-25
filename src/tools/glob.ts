import { z } from "zod"
import path from "node:path"
import { stat } from "node:fs/promises"
import { defineTool, type AnyTool } from "@/tools/registry"
import { okResult, errorResult } from "@/tools/types"
import { resolvePath, relativePath } from "@/tools/fs-util"
import { runRipgrep } from "@/tools/ripgrep"

import DESCRIPTION from "@/tools/prompts/glob.txt"

const LIMIT = 100

const Schema = z.object({
  pattern: z.string().describe("The glob pattern to match files against"),
  path: z.string().optional().describe("The directory to search in. Omit to use the current working directory."),
})
type Input = z.infer<typeof Schema>

export const globTool: AnyTool = defineTool<Input>({
  name: "glob",
  description: DESCRIPTION,
  inputSchema: Schema,
  concurrencySafe: true,
  permission: () => null,
  execute: async (input, ctx) => {
    const searchDir = input.path ? resolvePath(ctx.cwd, input.path) : ctx.cwd
    try {
      const info = await stat(searchDir)
      if (!info.isDirectory()) return errorResult(`glob path must be a directory: ${searchDir}`)
    } catch {
      return errorResult(`directory not found: ${searchDir}`)
    }

    let stdout: string
    try {
      stdout = await runRipgrep(["--files", "--glob", input.pattern], searchDir, ctx.signal)
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error))
    }

    const files = stdout.split("\n").filter((line) => line.length > 0)
    if (files.length === 0) return okResult("No files found", relativePath(ctx.cwd, searchDir), { count: 0 })

    const sorted = await sortByMtime(files.map((file) => path.resolve(searchDir, file)))
    const shown = sorted.slice(0, LIMIT)
    const truncated = sorted.length > LIMIT
    const lines = shown.slice()
    if (truncated) lines.push(`\n(Showing first ${LIMIT} of ${sorted.length}. Use a more specific pattern.)`)

    return okResult(lines.join("\n"), relativePath(ctx.cwd, searchDir), { count: sorted.length, truncated })
  },
})

async function sortByMtime(files: string[]): Promise<string[]> {
  const withTime = await Promise.all(
    files.map(async (file) => {
      try {
        const info = await stat(file)
        return { file, mtime: info.mtimeMs }
      } catch {
        return { file, mtime: 0 }
      }
    }),
  )
  withTime.sort((a, b) => b.mtime - a.mtime)
  return withTime.map((entry) => entry.file)
}
