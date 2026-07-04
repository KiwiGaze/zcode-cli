import { z } from "zod"
import { stat } from "node:fs/promises"
import { defineTool, type AnyTool } from "@/tools/registry"
import { okResult, errorResult } from "@/tools/types"
import { relativePath, resolvePath } from "@/tools/fs-util"
import { replace } from "@/tools/edit/replacers"
import { lineDiffStat } from "@/tools/diff"

import DESCRIPTION from "@/tools/prompts/edit.txt"

const Schema = z.object({
  filePath: z.string().describe("The absolute path to the file to modify"),
  oldString: z.string().describe("The text to replace"),
  newString: z.string().describe("The text to replace it with (must be different from oldString)"),
  replaceAll: z.boolean().optional().describe("Replace all occurrences of oldString (default false)"),
})
type Input = z.infer<typeof Schema>

function normalizeLineEndings(text: string): string {
  return text.replaceAll("\r\n", "\n")
}

export const editTool: AnyTool = defineTool<Input>({
  name: "edit",
  description: DESCRIPTION,
  inputSchema: Schema,
  permission: (input, ctx) => {
    const abs = resolvePath(ctx.cwd, input.filePath)
    return {
      tool: "edit",
      callId: ctx.callId,
      title: `edit: ${relativePath(ctx.cwd, abs)}`,
      key: `edit:${abs}`,
      subject: abs,
    }
  },
  execute: async (input, ctx) => {
    if (input.oldString === input.newString) {
      return errorResult("No changes to apply: oldString and newString are identical.")
    }
    const abs = resolvePath(ctx.cwd, input.filePath)
    const file = Bun.file(abs)
    if (!(await file.exists())) return errorResult(`File ${abs} not found`)
    const info = await stat(abs)
    if (info.isDirectory()) return errorResult(`Path is a directory, not a file: ${abs}`)
    if (!ctx.files.wasRead(abs)) {
      return errorResult(`File ${abs} was not read first. Use read before editing it.`)
    }
    if (ctx.files.isStale(abs, info.mtimeMs)) {
      return errorResult(`File ${abs} changed on disk since it was read. Re-read it before editing.`)
    }

    const contentOld = await file.text()
    let contentNew: string
    try {
      contentNew = replace(
        normalizeLineEndings(contentOld),
        normalizeLineEndings(input.oldString),
        normalizeLineEndings(input.newString),
        input.replaceAll ?? false,
      )
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error))
    }

    const useCrlf = contentOld.includes("\r\n")
    await Bun.write(abs, useCrlf ? contentNew.replaceAll("\n", "\r\n") : contentNew)
    ctx.files.markRead(abs, (await stat(abs)).mtimeMs)
    ctx.files.markTouched(abs)

    const stat_ = lineDiffStat(normalizeLineEndings(contentOld), contentNew)
    return okResult(
      "Edit applied successfully.",
      `${relativePath(ctx.cwd, abs)} (+${stat_.additions} -${stat_.deletions})`,
      { path: abs, additions: stat_.additions, deletions: stat_.deletions },
    )
  },
})
