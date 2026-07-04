import { z } from "zod"
import { defineTool, type AnyTool, ToolRegistry } from "@/tools/registry"
import { okResult, errorResult } from "@/tools/types"
import { FileState } from "@/tools/file-state"
import { TodoState } from "@/tools/todo-state"
import { createSession } from "@/session/session"
import { assistantText } from "@/session/messages"
import type { AgentRuntime } from "@/agent/runtime"

const DESCRIPTION = `Delegate a focused, read-only sub-task to a subagent and get back its findings.

Use this to parallelize research or search across the codebase: launch one task per independent
question and they run concurrently. The subagent has read, grep, glob, and webfetch tools only —
it cannot edit files, run shell commands, or spawn further subagents. Give it a self-contained
prompt; it returns a single text report, so ask for exactly the summary you need.`

/** Read-only toolset a subagent may use. Excludes write/edit/bash and task itself. */
const SUBAGENT_TOOLS = new Set(["read", "grep", "glob", "webfetch"])

const Schema = z.object({
  description: z.string().describe("A short (3-5 word) label for the sub-task"),
  prompt: z.string().describe("The full, self-contained instruction for the subagent"),
})
type Input = z.infer<typeof Schema>

export function createTaskTool(parent: AgentRuntime): AnyTool {
  return defineTool<Input>({
    name: "task",
    description: DESCRIPTION,
    inputSchema: Schema,
    permission: () => null,
    execute: async (input, ctx) => {
      const { query } = await import("@/agent/query")
      const childRuntime: AgentRuntime = {
        config: parent.config,
        registry: new ToolRegistry(parent.registry.list().filter((tool) => SUBAGENT_TOOLS.has(tool.name))),
        permissions: parent.permissions,
        files: new FileState(),
        todos: new TodoState(),
        instructions: parent.instructions,
        compactions: [],
        skills: [],
        ...(parent.llm === undefined ? {} : { llm: parent.llm }),
      }
      const childSession = createSession(ctx.cwd)

      ctx.onProgress(`▸ ${input.description}\n`)
      let finalText = ""
      try {
        for await (const event of query({
          prompt: input.prompt,
          session: childSession,
          config: parent.config,
          runtime: childRuntime,
          signal: ctx.signal,
        })) {
          switch (event.type) {
            case "permission-ask":
              // Subagent tools are read-only, so approve without prompting.
              event.respond("allow-once")
              break
            case "tool-start":
              ctx.onProgress(`  ${event.name}\n`)
              break
            case "done":
              finalText = assistantText(event.message)
              break
            case "error":
              return errorResult(`subagent error: ${event.error.message}`)
            default:
              break
          }
        }
      } catch (error) {
        return errorResult(`subagent failed: ${error instanceof Error ? error.message : String(error)}`)
      }

      const output = finalText.trim()
      if (output.length === 0) return errorResult("subagent produced no output")
      return okResult(output, input.description)
    },
  })
}
