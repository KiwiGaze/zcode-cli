import { test, expect } from "bun:test"
import { z } from "zod"
import { createToolSearchTool } from "@/tools/tool-search"
import { defineTool, type AnyTool, type ToolContext } from "@/tools/registry"
import { okResult } from "@/tools/types"
import { FileState } from "@/tools/file-state"
import { testConfig } from "../support/config"
import { testRuntime } from "../support/runtime"

function mcpTool(name: string, description: string): AnyTool {
  return defineTool<{ target: string }>({
    name,
    description,
    inputSchema: z.object({ target: z.string() }),
    permission: () => null,
    execute: async () => okResult("ran"),
  })
}

function context(): ToolContext {
  return {
    cwd: "/tmp/zcode-test",
    signal: new AbortController().signal,
    callId: "c1",
    sessionId: "s1",
    files: new FileState(),
    onProgress: () => {},
  }
}

function setup() {
  const config = testConfig({
    mcp: { servers: { srv: { type: "stdio", command: "bun", args: [], env: {}, defer: true } } },
  })
  const runtime = testRuntime(config, [
    mcpTool("mcp__srv__probe", "Check whether a remote host is reachable"),
    mcpTool("mcp__srv__deploy", "Ship the current build to production"),
  ])
  const tool = createToolSearchTool(runtime)
  runtime.registry.register(tool)
  return { runtime, tool }
}

test("toolsearch activates tools matching name or description case-insensitively", async () => {
  const { runtime, tool } = setup()

  // "REACHABLE" appears only in the description, and only in a different case.
  const result = await tool.execute({ query: "REACHABLE" }, context())

  expect(result.status).toBe("ok")
  expect([...runtime.deferred.activated]).toEqual(["mcp__srv__probe"])
  expect(result.title).toBe("activated: mcp__srv__probe")
  expect(result.metadata?.["activatedTools"]).toEqual(["mcp__srv__probe"])
  // The result carries the schema so the model can compose its next call immediately.
  expect(result.output).toContain("mcp__srv__probe")
  expect(result.output).toContain("inputSchema")
  expect(result.output).not.toContain("mcp__srv__deploy")
})

test("toolsearch without matches activates nothing", async () => {
  const { runtime, tool } = setup()

  const result = await tool.execute({ query: "nothing-matches-this" }, context())

  expect(result.status).toBe("error")
  expect(result.output).toContain("no matching deferred tools")
  expect([...runtime.deferred.activated]).toEqual([])

  // An empty query is not a wildcard.
  await tool.execute({ query: "   " }, context())
  expect([...runtime.deferred.activated]).toEqual([])
})

test("toolsearch never finds an already-activated tool", async () => {
  const { runtime, tool } = setup()

  await tool.execute({ query: "probe" }, context())
  expect([...runtime.deferred.activated]).toEqual(["mcp__srv__probe"])

  const again = await tool.execute({ query: "probe" }, context())
  expect(again.status).toBe("error")
  expect([...runtime.deferred.activated]).toEqual(["mcp__srv__probe"])
})

test("toolsearch needs no approval", () => {
  const { tool } = setup()
  expect(tool.permission({ query: "probe" }, context())).toBeNull()
})
