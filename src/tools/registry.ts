import { z } from "zod"
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
  /** Returns a permission request, or null when the call needs no approval. */
  permission: (input: In, ctx: ToolContext) => PermissionRequest | null
  execute: (input: In, ctx: ToolContext) => Promise<ToolResult>
}

export interface AnyTool {
  name: string
  description: string
  jsonSchema: Record<string, unknown>
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
    parse: (raw) => {
      const result = tool.inputSchema.safeParse(raw)
      if (result.success) return { ok: true, value: result.data }
      const message = result.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")
      return { ok: false, error: `invalid arguments: ${message}` }
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
