import { z } from "zod"
import { formatZodIssues } from "@/util/zod"
import type { ToolResult } from "@/tools/types"
import type { PermissionRequest } from "@/permissions/types"
import type { LLMToolDecl } from "@/llm/types"
import type { FileState } from "@/tools/file-state"

export interface ToolContext {
  cwd: string
  signal: AbortSignal
  callId: string
  sessionId: string
  onProgress: (chunk: string) => void
  files: FileState
}

export interface ZCodeTool<In = unknown> {
  name: string
  description: string
  inputSchema: z.ZodType<In>
  /**
   * True only when running this tool concurrently with the model stream and with other tools cannot
   * mutate state anything else observes. A tool that writes files, shells out, or updates shared
   * runtime state is not concurrency-safe, however harmless it looks.
   */
  concurrencySafe?: boolean
  /** Returns a permission request, or null when the call needs no approval. */
  permission: (input: In, ctx: ToolContext) => PermissionRequest | null
  execute: (input: In, ctx: ToolContext) => Promise<ToolResult>
}

export interface AnyTool {
  name: string
  description: string
  jsonSchema: Record<string, unknown>
  /** Defaults to false, so a tool built outside `defineTool` is never eligible by accident. */
  readonly concurrencySafe: boolean
  parse: (raw: unknown) => { ok: true; value: unknown } | { ok: false; error: string }
  permission: (input: unknown, ctx: ToolContext) => PermissionRequest | null
  execute: (input: unknown, ctx: ToolContext) => Promise<ToolResult>
}

export function defineTool<In>(tool: ZCodeTool<In>): AnyTool {
  const jsonSchema = z.toJSONSchema(tool.inputSchema, { target: "draft-2020-12" }) as Record<string, unknown>
  return {
    name: tool.name,
    description: tool.description,
    jsonSchema,
    concurrencySafe: tool.concurrencySafe ?? false,
    parse: (raw) => {
      const result = tool.inputSchema.safeParse(raw)
      if (result.success) return { ok: true, value: result.data }
      return { ok: false, error: `invalid arguments: ${formatZodIssues(result.error)}` }
    },
    permission: (input, ctx) => tool.permission(input as In, ctx),
    execute: (input, ctx) => tool.execute(input as In, ctx),
  }
}

export class ToolRegistry {
  private tools = new Map<string, AnyTool>()

  constructor(tools: AnyTool[] = []) {
    for (const tool of tools) this.register(tool)
  }

  register(tool: AnyTool): void {
    this.tools.set(tool.name, tool)
  }

  unregister(name: string): void {
    this.tools.delete(name)
  }

  get(name: string): AnyTool | undefined {
    return this.tools.get(name)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  names(): string[] {
    return [...this.tools.keys()]
  }

  list(): AnyTool[] {
    return [...this.tools.values()]
  }

  declarations(): LLMToolDecl[] {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.jsonSchema,
    }))
  }
}
