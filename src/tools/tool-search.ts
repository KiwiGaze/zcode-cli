import { z } from "zod"
import { defineTool, type AnyTool } from "@/tools/registry"
import { okResult, errorResult } from "@/tools/types"
import { searchPendingDeferred, TOOL_SEARCH_NAME } from "@/tools/deferred"
import type { AgentRuntime } from "@/agent/runtime"

const DESCRIPTION = `Load the full schemas of deferred tools so you can call them.

Some tools are listed by name only until you activate them, which keeps their schemas out of every
request. Search by tool name or by what you need it to do; every match is activated and its schema
is available from your next step onward. Activation does not grant permission — an activated tool
still follows the usual approval rules.`

const Schema = z.object({
  query: z.string().describe("Tool name or keyword to search for"),
})
type Input = z.infer<typeof Schema>

export function createToolSearchTool(runtime: AgentRuntime): AnyTool {
  return defineTool<Input>({
    name: TOOL_SEARCH_NAME,
    description: DESCRIPTION,
    inputSchema: Schema,
    permission: () => null,
    execute: async (input) => {
      const matches = searchPendingDeferred(runtime.registry, runtime.config, runtime.deferred, input.query)
      if (matches.length === 0) {
        return errorResult(`no matching deferred tools: ${input.query}`, "toolsearch: no matches")
      }

      const names = matches.map((tool) => tool.name)
      runtime.deferred.activate(names)
      const schemas = matches.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.jsonSchema,
      }))
      return okResult(JSON.stringify(schemas, null, 2), `activated: ${names.join(", ")}`, { activatedTools: names })
    },
  })
}
