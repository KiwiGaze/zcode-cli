import { z } from "zod"
import { defineTool, type AnyTool } from "@/tools/registry"
import { okResult, errorResult } from "@/tools/types"
import { htmlToMarkdown, htmlToText } from "@/tools/html"

import DESCRIPTION from "@/tools/prompts/webfetch.txt"

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 30 * 1000
const MAX_TIMEOUT_MS = 120 * 1000

const Schema = z.object({
  url: z.string().describe("The URL to fetch content from"),
  format: z.enum(["text", "markdown", "html"]).default("markdown").describe("Return format. Defaults to markdown."),
  timeout: z.number().int().positive().optional().describe("Optional timeout in seconds (max 120)"),
})
type Input = z.infer<typeof Schema>

export const webfetchTool: AnyTool = defineTool<Input>({
  name: "webfetch",
  description: DESCRIPTION,
  inputSchema: Schema,
  concurrencySafe: true,
  permission: (input, ctx) => ({
    tool: "webfetch",
    callId: ctx.callId,
    title: `webfetch: ${input.url}`,
    key: `webfetch:${originOf(input.url)}`,
    subject: input.url,
  }),
  execute: async (input, ctx) => {
    let url = input.url
    if (url.startsWith("http://")) url = `https://${url.slice("http://".length)}`
    if (!url.startsWith("https://")) return errorResult("URL must start with http:// or https://")

    const timeout = Math.min((input.timeout ?? DEFAULT_TIMEOUT_MS / 1000) * 1000, MAX_TIMEOUT_MS)
    const timer = new AbortController()
    const timerId = setTimeout(() => timer.abort(), timeout)
    const onAbort = (): void => timer.abort()
    ctx.signal.addEventListener("abort", onAbort, { once: true })

    try {
      const response = await fetch(url, {
        signal: timer.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; ZCodeCLI)",
          Accept: acceptHeader(input.format),
          "Accept-Language": "en-US,en;q=0.9",
        },
      })
      if (!response.ok) return errorResult(`request failed: HTTP ${response.status}`)

      const contentType = response.headers.get("content-type") ?? ""
      const buffer = await response.arrayBuffer()
      if (buffer.byteLength > MAX_RESPONSE_SIZE) return errorResult("Response too large (exceeds 5MB limit)")
      const content = new TextDecoder().decode(buffer)
      const isHtml = contentType.includes("text/html")
      const title = `${url} (${contentType || "unknown"})`

      if (input.format === "html" || !isHtml) return okResult(content, title)
      if (input.format === "text") return okResult(htmlToText(content), title)
      return okResult(htmlToMarkdown(content), title)
    } catch (error) {
      if (timer.signal.aborted && !ctx.signal.aborted) return errorResult(`request timed out after ${timeout}ms`)
      return errorResult(error instanceof Error ? error.message : String(error))
    } finally {
      clearTimeout(timerId)
      ctx.signal.removeEventListener("abort", onAbort)
    }
  },
})

function acceptHeader(format: Input["format"]): string {
  switch (format) {
    case "markdown":
      return "text/markdown;q=1.0, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
    case "text":
      return "text/plain;q=1.0, text/html;q=0.8, */*;q=0.1"
    case "html":
      return "text/html;q=1.0, application/xhtml+xml;q=0.9, */*;q=0.1"
  }
}

function originOf(url: string): string {
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).host
  } catch {
    return url
  }
}
