import os from "node:os"
import type { ResolvedConfig } from "@/config/config"
import type { InstructionFile } from "@/agent/instructions"

const IDENTITY = `You are ZCode CLI, a terminal coding agent running in the user's project directory.

You help with software engineering tasks: answering questions about the codebase, writing and
modifying code, running commands, and debugging. Be direct and concise — your output is rendered
in a terminal. Prefer short prose; use lists only when they genuinely help. When you reference
code, use the file path (with a line number when helpful) so the user can find it.

You have tools to read, search, write, and edit files, run shell commands, and fetch web pages.
Prefer the dedicated tools over shell equivalents. Read a file before editing it. After making
changes, verify them (run the tests or the relevant command) when you can.

Never fabricate file contents or command output. If you are unsure, say so.`

export function buildSystemPrompt(config: ResolvedConfig, instructions: InstructionFile[] = []): string {
  const parts = [IDENTITY, environmentSection(config)]
  if (instructions.length > 0) parts.push(instructionsSection(instructions))
  return parts.join("\n\n")
}

function instructionsSection(instructions: InstructionFile[]): string {
  const blocks = instructions.map((file) => `# From ${file.path}\n${file.content}`)
  return ["# Project instructions", "Follow these project-specific rules:", "", blocks.join("\n\n")].join("\n")
}

function environmentSection(config: ResolvedConfig): string {
  return [
    "# Environment",
    `Working directory: ${config.cwd}`,
    `Platform: ${process.platform} (${os.release()})`,
    `Date: ${new Date().toDateString()}`,
  ].join("\n")
}
