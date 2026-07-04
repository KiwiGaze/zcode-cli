import { z } from "zod"
import { stat, mkdir } from "node:fs/promises"
import path from "node:path"
import { defineTool, type AnyTool } from "@/tools/registry"
import { okResult, errorResult } from "@/tools/types"
import { relativePath, resolvePath } from "@/tools/fs-util"
import { lineDiffStat } from "@/tools/diff"

import DESCRIPTION from "@/tools/prompts/write.txt"

const Schema = z.object({
  filePath: z.string().describe("The absolute path to the file to write (must be absolute, not relative)"),
  content: z.string().describe("The content to write to the file"),
})
type Input = z.infer<typeof Schema>

export const writeTool: AnyTool = defineTool<Input>({
  name: "write",
  description: DESCRIPTION,
  inputSchema: Schema,
  permission: (input, ctx) => {
    const abs = resolvePath(ctx.cwd, input.filePath)
    const rel = relativePath(ctx.cwd, abs)
    return {
      tool: "write",
      callId: ctx.callId,
      title: `write: ${rel}`,
      key: `write:${abs}`,
      subject: abs,
    }
  },
  execute: async (input, ctx) => {
    const abs = resolvePath(ctx.cwd, input.filePath)
    const file = Bun.file(abs)
    const exists = await file.exists()
    if (exists) {
      const info = await stat(abs)
      if (info.isDirectory()) return errorResult(`Path is a directory, not a file: ${abs}`)
      if (!ctx.files.wasRead(abs)) {
        return errorResult(`File ${abs} exists but was not read first. Use read before overwriting it.`)
      }
      if (ctx.files.isStale(abs, info.mtimeMs)) {
        return errorResult(`File ${abs} changed on disk since it was read. Re-read it before writing.`)
      }
    }

    const oldContent = exists ? await file.text() : ""
    await mkdir(path.dirname(abs), { recursive: true })
    await Bun.write(abs, input.content)
    ctx.files.markRead(abs, (await stat(abs)).mtimeMs)

    const stat_ = lineDiffStat(oldContent, input.content)
    return okResult(
      exists ? "Wrote file successfully." : "Created file successfully.",
      `${relativePath(ctx.cwd, abs)} (+${stat_.additions} -${stat_.deletions})`,
      { path: abs, additions: stat_.additions, deletions: stat_.deletions },
    )
  },
})
