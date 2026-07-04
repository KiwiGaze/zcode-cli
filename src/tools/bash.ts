import { z } from "zod"
import { defineTool, type AnyTool } from "@/tools/registry"
import { okResult, errorResult, type ToolResult } from "@/tools/types"
import { resolvePath } from "@/tools/fs-util"

import DESCRIPTION from "@/tools/prompts/bash.txt"

const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000
const MAX_LINES = 2000
const MAX_BYTES = 50 * 1024

const Schema = z.object({
  command: z.string().describe("The command to execute"),
  timeout: z.number().int().positive().optional().describe("Optional timeout in milliseconds"),
  workdir: z.string().optional().describe("Working directory to run the command in. Defaults to the project directory."),
})
type Input = z.infer<typeof Schema>

export function bashPrefix(command: string): string {
  const trimmed = command.trim()
  const firstToken = trimmed.split(/\s+/)[0] ?? ""
  return firstToken
}

export const bashTool: AnyTool = defineTool<Input>({
  name: "bash",
  description: DESCRIPTION,
  inputSchema: Schema,
  permission: (input, ctx) => ({
    tool: "bash",
    callId: ctx.callId,
    title: `bash: ${input.command}`,
    key: `bash:${bashPrefix(input.command)}`,
    subject: input.command.trim(),
  }),
  execute: async (input, ctx) => {
    const cwd = input.workdir ? resolvePath(ctx.cwd, input.workdir) : ctx.cwd
    const timeout = input.timeout ?? DEFAULT_TIMEOUT_MS
    const shell = process.env["SHELL"] ?? "/bin/sh"

    let proc: Bun.Subprocess<"ignore", "pipe", "pipe">
    try {
      proc = Bun.spawn([shell, "-c", input.command], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
      })
    } catch (error) {
      return errorResult(`failed to start command: ${error instanceof Error ? error.message : String(error)}`)
    }

    let timedOut = false
    let aborted = false
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill()
    }, timeout)
    const onAbort = (): void => {
      aborted = true
      proc.kill()
    }
    ctx.signal.addEventListener("abort", onAbort, { once: true })

    let stdout = ""
    let stderr = ""
    try {
      ;[stdout, stderr] = await Promise.all([drain(proc.stdout, ctx.onProgress), drain(proc.stderr, ctx.onProgress)])
      await proc.exited
    } finally {
      clearTimeout(timer)
      ctx.signal.removeEventListener("abort", onAbort)
    }

    const exitCode = proc.exitCode ?? proc.signalCode ?? null
    const combined = [stdout, stderr].filter((part) => part.length > 0).join("\n")
    const { text, truncated } = tail(combined, MAX_LINES, MAX_BYTES)

    const notes: string[] = []
    if (timedOut) notes.push(`command exceeded timeout of ${timeout}ms and was terminated`)
    if (aborted) notes.push("command was interrupted by the user")

    let output = text.length > 0 ? text : "(no output)"
    if (truncated) output = `...output truncated...\n\n${output}`
    if (notes.length > 0) output += `\n\n<shell>\n${notes.join("\n")}\n</shell>`

    const title = `${input.command}${exitCode ? ` (exit ${exitCode})` : ""}`
    const result: ToolResult =
      (exitCode !== null && exitCode !== 0) || timedOut || aborted
        ? { status: aborted ? "aborted" : "error", output, title }
        : okResult(output, title, { exit: exitCode })
    return result
  },
})

async function drain(stream: ReadableStream<Uint8Array>, onProgress: (chunk: string) => void): Promise<string> {
  const decoder = new TextDecoder()
  let full = ""
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true })
    full += text
    onProgress(text)
  }
  full += decoder.decode()
  return full
}

function tail(text: string, maxLines: number, maxBytes: number): { text: string; truncated: boolean } {
  const lines = text.split("\n")
  if (lines.length <= maxLines && Buffer.byteLength(text, "utf8") <= maxBytes) {
    return { text, truncated: false }
  }
  const out: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const line = lines[i] ?? ""
    const size = Buffer.byteLength(line, "utf8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) break
    out.unshift(line)
    bytes += size
  }
  return { text: out.join("\n"), truncated: true }
}
