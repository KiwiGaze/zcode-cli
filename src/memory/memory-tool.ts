import { z } from "zod"
import { defineTool, type AnyTool } from "@/tools/registry"
import { okResult, errorResult } from "@/tools/types"
import {
  deleteMemory,
  listMemories,
  loadMemoryIndex,
  MAX_MEMORY_DESCRIPTION_CHARS,
  MAX_MEMORY_NAME_CHARS,
  saveMemory,
} from "@/memory/store"

const DESCRIPTION = `Record durable facts about this project or user in persistent memory, and list what is stored.

Save when you learn something that will still matter in a later session: the user's preferences and
corrections (with the reasoning behind them), ongoing goals and decisions, or pointers to external
resources. Do NOT save code structure or patterns (read the code instead), git history, anything
already stated in AGENTS.md or CLAUDE.md, or details that only matter to the current task.

Operations: "save" (name, description, type, content — the filename is derived and the index
rebuilt), "delete" (filename exactly as listed in the index), "list" (the current index).`

/**
 * The index and the recall manifest are one record per line, so a newline in either field would
 * forge an extra entry that later sessions read back as real.
 */
const singleLine = z
  .string()
  .min(1)
  .regex(/^[^\r\n]+$/, "must be a single line")

const Schema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("save"),
    name: singleLine.max(MAX_MEMORY_NAME_CHARS).describe("Short memory name; becomes part of the filename"),
    description: singleLine
      .max(MAX_MEMORY_DESCRIPTION_CHARS)
      .describe("One-line summary, used to decide relevance during recall"),
    type: z.enum(["user", "feedback", "project", "reference"]).describe("Which kind of memory this is"),
    content: z.string().min(1).describe("The memory body, in markdown"),
  }),
  z.object({
    operation: z.literal("delete"),
    filename: z.string().min(1).describe("Filename to delete, exactly as listed in the index"),
  }),
  z.object({ operation: z.literal("list") }),
])
type Input = z.infer<typeof Schema>

/**
 * The only write path into the memory directory. Tool calls run concurrently, so mutations are
 * serialized: an index rebuild reads the whole directory and must not interleave with another save.
 */
export function createMemoryTool(dir: string): AnyTool {
  let queue: Promise<unknown> = Promise.resolve()
  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work)
    queue = next.then(
      () => {},
      () => {},
    )
    return next
  }

  return defineTool<Input>({
    name: "memory",
    description: DESCRIPTION,
    inputSchema: Schema,
    permission: (input, ctx) => ({
      tool: "memory",
      callId: ctx.callId,
      title: memoryTitle(input),
      key: `memory:${input.operation}`,
      subject: input.operation,
    }),
    execute: async (input) => {
      if (input.operation === "list") {
        const index = await loadMemoryIndex(dir)
        const entries = await listMemories(dir)
        if (entries.length === 0) return okResult("(no memories saved yet)", "memory: 0 entries")
        return okResult(index, `memory: ${entries.length} ${entries.length === 1 ? "entry" : "entries"}`)
      }

      if (input.operation === "save") {
        const filename = await serialize(() =>
          saveMemory(dir, {
            name: input.name,
            description: input.description,
            type: input.type,
            content: input.content,
          }),
        )
        return okResult(`saved ${filename}`, `memory: saved ${filename}`)
      }

      const deleted = await serialize(() => deleteMemory(dir, input.filename))
      if (!deleted) return errorResult(`no such memory: ${input.filename}`, "memory: not found")
      return okResult(`deleted ${input.filename}`, `memory: deleted ${input.filename}`)
    },
  })
}

function memoryTitle(input: Input): string {
  if (input.operation === "save") return `memory: save "${input.name}"`
  if (input.operation === "delete") return `memory: delete ${input.filename}`
  return "memory: list"
}
