import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import type { McpServerConfig } from "@/config/config"
import type { AnyTool, ToolContext } from "@/tools/registry"
import { okResult, errorResult, type ToolResult } from "@/tools/types"
import { ZCodeError } from "@/util/errors"

const CLIENT_INFO = { name: "zcode-cli", version: "0.1.0" }

export interface McpConnection {
  server: string
  status: "connected" | "failed"
  toolCount: number
  error?: string
  client?: Client
}

interface McpToolInfo {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`
}

async function connectServer(config: McpServerConfig): Promise<Client> {
  const client = new Client(CLIENT_INFO)
  const transport: Transport =
    config.type === "http"
      ? new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } })
      : new StdioClientTransport({ command: config.command, args: config.args, env: { ...processEnv(), ...config.env } })
  await client.connect(transport)
  return client
}

function processEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
  return env
}

export async function connectMcpServers(
  servers: Record<string, McpServerConfig>,
): Promise<{ tools: AnyTool[]; connections: McpConnection[] }> {
  const tools: AnyTool[] = []
  const connections: McpConnection[] = []

  for (const [name, config] of Object.entries(servers)) {
    try {
      const client = await connectServer(config)
      const listed = await client.listTools()
      const serverTools = listed.tools as McpToolInfo[]
      for (const tool of serverTools) tools.push(buildMcpTool(name, client, tool))
      connections.push({ server: name, status: "connected", toolCount: serverTools.length, client })
    } catch (error) {
      connections.push({
        server: name,
        status: "failed",
        toolCount: 0,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return { tools, connections }
}

function buildMcpTool(server: string, client: Client, info: McpToolInfo): AnyTool {
  const fullName = mcpToolName(server, info.name)
  return {
    name: fullName,
    mcpServer: server,
    description: info.description ?? `MCP tool ${info.name} from ${server}`,
    jsonSchema: info.inputSchema,
    // A remote tool's side effects are unknown, so it is never eligible for early execution.
    concurrencySafe: false,
    parse: (raw) => {
      if (raw === null || typeof raw !== "object") return { ok: false, error: "arguments must be an object" }
      return { ok: true, value: raw }
    },
    permission: (input, ctx: ToolContext) => ({
      tool: fullName,
      callId: ctx.callId,
      title: `${server}: ${info.name}`,
      detail: safeJson(input),
      key: `mcp:${fullName}`,
      subject: info.name,
    }),
    execute: async (input) => callMcpTool(client, info.name, input),
  }
}

async function callMcpTool(client: Client, toolName: string, input: unknown): Promise<ToolResult> {
  try {
    const result = await client.callTool({ name: toolName, arguments: input as Record<string, unknown> })
    const text = renderContent(result.content)
    if (result.isError === true) return errorResult(text.length > 0 ? text : "MCP tool returned an error")
    return okResult(text.length > 0 ? text : "(no output)")
  } catch (error) {
    throw new ZCodeError("mcp", error instanceof Error ? error.message : String(error))
  }
}

interface ContentBlock {
  type: string
  text?: string
  data?: string
  mimeType?: string
}

function renderContent(content: unknown): string {
  if (!Array.isArray(content)) return ""
  const parts: string[] = []
  for (const block of content as ContentBlock[]) {
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text)
    else if (block.type === "image") parts.push(`[image ${block.mimeType ?? "unknown"}]`)
    else if (block.type === "audio") parts.push(`[audio ${block.mimeType ?? "unknown"}]`)
    else parts.push(`[${block.type}]`)
  }
  return parts.join("\n")
}

function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value)
    return text.length > 200 ? `${text.slice(0, 199)}…` : text
  } catch {
    return ""
  }
}

export async function closeConnections(connections: McpConnection[]): Promise<void> {
  await Promise.all(
    connections.map(async (connection) => {
      if (connection.client !== undefined) {
        try {
          await connection.client.close()
        } catch {
          // best-effort cleanup
        }
      }
    }),
  )
}
