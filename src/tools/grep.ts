import { z } from "zod"
import path from "node:path"
import { defineTool, type AnyTool } from "@/tools/registry"
import { okResult, errorResult } from "@/tools/types"
import { resolvePath } from "@/tools/fs-util"
import { runRipgrep } from "@/tools/ripgrep"

import DESCRIPTION from "@/tools/prompts/grep.txt"

const LIMIT = 100

const Schema = z.object({
  pattern: z.string().describe("The regex pattern to search for in file contents"),
  path: z.string().optional().describe("The directory to search in. Defaults to the current working directory."),
  include: z.string().optional().describe('File pattern to include (e.g. "*.js", "*.{ts,tsx}")'),
})
type Input = z.infer<typeof Schema>

interface RgLine {
  type: string
  data: { path: { text: string }; line_number: number; lines: { text: string } }
}

export const grepTool: AnyTool = defineTool<Input>({
  name: "grep",
  description: DESCRIPTION,
  inputSchema: Schema,
  permission: () => null,
  execute: async (input, ctx) => {
    if (input.pattern.length === 0) return errorResult("pattern is required")
    const searchDir = input.path ? resolvePath(ctx.cwd, input.path) : ctx.cwd
    const args = ["--json", "--max-count", String(LIMIT), "-e", input.pattern]
    if (input.include !== undefined) args.push("--glob", input.include)
    args.push(searchDir)

    let stdout: string
    try {
      stdout = await runRipgrep(args, ctx.cwd, ctx.signal)
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error))
    }

    const matches: { path: string; line: number; text: string }[] = []
    for (const raw of stdout.split("\n")) {
      if (raw.length === 0) continue
      let parsed: RgLine
      try {
        parsed = JSON.parse(raw) as RgLine
      } catch {
        continue
      }
      if (parsed.type !== "match") continue
      matches.push({
        path: path.resolve(searchDir, parsed.data.path.text),
        line: parsed.data.line_number,
        text: parsed.data.lines.text.replace(/\n$/, ""),
      })
      if (matches.length >= LIMIT) break
    }

    if (matches.length === 0) return okResult("No matches found", input.pattern, { matches: 0 })

    const truncated = matches.length >= LIMIT
    const lines = [`Found ${matches.length} match${matches.length === 1 ? "" : "es"}${truncated ? " (more available)" : ""}`]
    let current = ""
    for (const match of matches) {
      if (current !== match.path) {
        if (current !== "") lines.push("")
        current = match.path
        lines.push(`${match.path}:`)
      }
      lines.push(`  ${match.line}: ${match.text}`)
    }
    if (truncated) lines.push("\n(Results truncated. Use a more specific path or pattern.)")

    return okResult(lines.join("\n"), input.pattern, { matches: matches.length, truncated })
  },
})
