import { test, expect, afterEach } from "bun:test"
import path from "node:path"
import { connectMcpServers, closeConnections, mcpToolName, type McpConnection } from "@/mcp/client"
import type { ToolContext } from "@/tools/registry"
import { FileState } from "@/tools/file-state"

const SERVER = path.join(import.meta.dir, "..", "support", "mcp-echo-server.ts")

let open: McpConnection[] = []
afterEach(async () => {
  await closeConnections(open)
  open = []
})

function context(): ToolContext {
  return { cwd: process.cwd(), signal: new AbortController().signal, callId: "c1", sessionId: "s1", files: new FileState(), onProgress: () => {} }
}

test("connects to a stdio MCP server and namespaces its tools", async () => {
  const { tools, connections } = await connectMcpServers({
    test: { type: "stdio", command: "bun", args: [SERVER], env: {}, defer: false },
  })
  open = connections
  expect(connections[0]?.status).toBe("connected")
  expect(connections[0]?.toolCount).toBe(1)

  const echo = tools.find((tool) => tool.name === mcpToolName("test", "echo"))
  expect(echo).toBeDefined()
  expect(echo?.name).toBe("mcp__test__echo")

  const result = await echo?.execute({ message: "hi" }, context())
  expect(result?.status).toBe("ok")
  expect(result?.output).toBe("echo: hi")
})

test("MCP tools default to an ask permission request", async () => {
  const { tools, connections } = await connectMcpServers({
    test: { type: "stdio", command: "bun", args: [SERVER], env: {}, defer: false },
  })
  open = connections
  const echo = tools.find((tool) => tool.name === mcpToolName("test", "echo"))
  const request = echo?.permission({ message: "hi" }, context())
  expect(request).not.toBeNull()
  expect(request?.tool).toBe("mcp__test__echo")
})

test("a failed server is reported without throwing", async () => {
  const { tools, connections } = await connectMcpServers({
    broken: { type: "stdio", command: "this-command-does-not-exist-zzz", args: [], env: {}, defer: false },
  })
  open = connections
  expect(tools).toHaveLength(0)
  expect(connections[0]?.status).toBe("failed")
})
