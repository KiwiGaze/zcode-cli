import { test, expect } from "bun:test"
import { z } from "zod"
import {
  DeferredState,
  isDeferredTool,
  pendingDeferredTools,
  projectDeclarations,
  TOOL_SEARCH_NAME,
} from "@/tools/deferred"
import { createToolSearchTool } from "@/tools/tool-search"
import { defineTool, ToolRegistry, type AnyTool } from "@/tools/registry"
import { okResult } from "@/tools/types"
import type { ResolvedConfig } from "@/config/config"
import { testConfig } from "../support/config"
import { testRuntime } from "../support/runtime"

function mcpTool(name: string, description: string, server: string): AnyTool {
  return {
    ...defineTool<{ target: string }>({
      name,
      description,
      inputSchema: z.object({ target: z.string().describe("what to probe") }),
      permission: () => null,
      execute: async () => okResult("probed"),
    }),
    mcpServer: server,
  }
}

function deferConfig(servers: Record<string, boolean>): ResolvedConfig {
  return testConfig({
    mcp: {
      servers: Object.fromEntries(
        Object.entries(servers).map(([name, defer]) => [
          name,
          { type: "stdio" as const, command: "bun", args: [], env: {}, defer },
        ]),
      ),
    },
  })
}

function setup(servers: Record<string, boolean>, tools: AnyTool[]) {
  const config = deferConfig(servers)
  const runtime = testRuntime(config, tools)
  runtime.registry.register(createToolSearchTool(runtime))
  return { config, runtime, state: runtime.deferred }
}

test("projectDeclarations hides deferred tools until activated", () => {
  const probe = mcpTool("mcp__srv__probe", "probe a remote host", "srv")
  const { config, runtime, state } = setup({ srv: true }, [probe])

  const before = projectDeclarations(runtime.registry, config, state)
  expect(before.map((decl) => decl.name)).not.toContain("mcp__srv__probe")
  expect(JSON.stringify(before)).not.toContain("what to probe")

  state.activate(["mcp__srv__probe"])
  const after = projectDeclarations(runtime.registry, config, state)
  const activated = after.find((decl) => decl.name === "mcp__srv__probe")
  expect(activated).toBeDefined()
  expect(JSON.stringify(activated?.inputSchema)).toContain("what to probe")
})

test("projectDeclarations omits toolsearch when nothing is deferred", () => {
  const probe = mcpTool("mcp__srv__probe", "probe a remote host", "srv")
  const { config, runtime, state } = setup({ srv: false }, [probe])

  const decls = projectDeclarations(runtime.registry, config, state)
  expect(decls.map((decl) => decl.name)).toContain("mcp__srv__probe")
  expect(decls.map((decl) => decl.name)).not.toContain(TOOL_SEARCH_NAME)
})

test("projectDeclarations lists pending names in the toolsearch description", () => {
  const probe = mcpTool("mcp__srv__probe", "probe a remote host", "srv")
  const scan = mcpTool("mcp__srv__scan", "scan a subnet", "srv")
  const { config, runtime, state } = setup({ srv: true }, [probe, scan])

  const before = projectDeclarations(runtime.registry, config, state)
  const search = before.find((decl) => decl.name === TOOL_SEARCH_NAME)
  expect(search?.description).toContain("mcp__srv__probe")
  expect(search?.description).toContain("mcp__srv__scan")

  state.activate(["mcp__srv__probe"])
  const after = projectDeclarations(runtime.registry, config, state)
  const narrowed = after.find((decl) => decl.name === TOOL_SEARCH_NAME)
  expect(narrowed?.description).not.toContain("mcp__srv__probe")
  expect(narrowed?.description).toContain("mcp__srv__scan")
  expect(after.map((decl) => decl.name)).toContain("mcp__srv__probe")
})

test("isDeferredTool applies only to servers opted into defer", () => {
  const config = deferConfig({ hidden: true, plain: false })

  expect(isDeferredTool(mcpTool("mcp__hidden__probe", "probe", "hidden"), config)).toBe(true)
  expect(isDeferredTool(mcpTool("mcp__plain__probe", "probe", "plain"), config)).toBe(false)
  expect(isDeferredTool(mcpTool("mcp__unknown__probe", "probe", "unknown"), config)).toBe(false)
  // Built-in tools are never deferred, whatever they are called.
  expect(isDeferredTool(mcpTool("read", "read", "plain"), config)).toBe(false)
  expect(isDeferredTool(defineTool({
    name: "mcp__hidden__impostor",
    description: "not an MCP tool",
    inputSchema: z.object({}),
    permission: () => null,
    execute: async () => okResult("ok"),
  }), config)).toBe(false)

  const registry = new ToolRegistry([
    mcpTool("mcp__hidden__a", "a", "hidden"),
    mcpTool("mcp__plain__b", "b", "plain"),
  ])
  const pending = pendingDeferredTools(registry, config, new DeferredState())
  expect(pending.map((tool) => tool.name)).toEqual(["mcp__hidden__a"])
})

test("isDeferredTool uses the originating server identity", () => {
  const config = deferConfig({ foo: true, foo__admin: false })

  expect(isDeferredTool(mcpTool("mcp__foo__read", "read", "foo"), config)).toBe(true)
  expect(isDeferredTool(mcpTool("mcp__foo__admin__read", "read", "foo__admin"), config)).toBe(false)
})

test("deferral follows MCP origin when server and tool names are textually ambiguous", () => {
  const config = deferConfig({ foo: true, foo__admin: false })
  const fromFoo = mcpTool("mcp__foo__admin__read", "read admin data", "foo")
  const registry = new ToolRegistry([fromFoo])

  const pending = pendingDeferredTools(registry, config, new DeferredState())

  expect(pending.map((tool) => tool.name)).toEqual(["mcp__foo__admin__read"])
})

test("DeferredState activation is additive and never reverses", () => {
  const state = new DeferredState()
  expect([...state.activated]).toEqual([])

  state.activate(["a", "b"])
  state.activate(["b", "c"])
  expect([...state.activated].sort()).toEqual(["a", "b", "c"])
})
