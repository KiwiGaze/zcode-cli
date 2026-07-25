import type { ResolvedConfig } from "@/config/config"
import type { InstructionFile } from "@/agent/instructions"
import { instructionsSection } from "@/agent/session-context"

const IDENTITY = `You are ZCode CLI, a terminal coding agent running in the user's project directory.

You help with software engineering tasks: answering questions about the codebase, writing and
modifying code, running commands, and debugging. Be direct and concise — your output is rendered
in a terminal. Prefer short prose; use lists only when they genuinely help. When you reference
code, use the file path (with a line number when helpful) so the user can find it.

You have tools to read, search, write, and edit files, run shell commands, and fetch web pages.
Prefer the dedicated tools over shell equivalents. Read a file before editing it. After making
changes, verify them (run the tests or the relevant command) when you can.

Never fabricate file contents or command output. If you are unsure, say so.`

/** Return the universal, identity-only system prompt. */
export function buildSystemPrompt(): string {
  return IDENTITY
}

/**
 * A child agent's system prompt: its role body, grounded with the working directory and the
 * project's instruction files. The parent's identity and skill catalog are deliberately excluded —
 * the role body *is* the child's identity, and a child has no skill tool.
 */
export function buildSubagentPrompt(
  roleBody: string,
  config: ResolvedConfig,
  instructions: readonly InstructionFile[] = [],
): string {
  const parts = [roleBody, environmentSection(config)]
  if (instructions.length > 0) parts.push(instructionsSection(instructions))
  return parts.join("\n\n")
}

function environmentSection(config: ResolvedConfig): string {
  return ["# Environment", `Working directory: ${config.cwd}`, `Platform: ${process.platform}`].join("\n")
}
