#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

const server = new McpServer({ name: "test-echo", version: "0.0.1" })

server.registerTool(
  "echo",
  {
    description: "Echo the provided message back",
    inputSchema: { message: z.string() },
  },
  async ({ message }) => ({ content: [{ type: "text", text: `echo: ${message}` }] }),
)

await server.connect(new StdioServerTransport())
