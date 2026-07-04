export interface SlashCommand {
  name: string
  description: string
}

export type CommandEffect =
  | { kind: "none" }
  | { kind: "notice"; text: string; tone?: "info" | "warn" }
  | { kind: "open-model-picker" }
  | { kind: "clear" }
  | { kind: "compact" }
  | { kind: "resume" }
  | { kind: "toggle-plan" }
  | { kind: "show-permissions" }
  | { kind: "show-mcp" }
  | { kind: "exit" }

export const COMMANDS: SlashCommand[] = [
  { name: "help", description: "list commands" },
  { name: "model", description: "switch provider / model" },
  { name: "clear", description: "clear the conversation" },
  { name: "resume", description: "resume a previous session" },
  { name: "compact", description: "summarize and compact context" },
  { name: "plan", description: "toggle plan mode (read-only)" },
  { name: "permissions", description: "show permission settings" },
  { name: "mcp", description: "show MCP connection status" },
  { name: "quit", description: "exit ZCode CLI" },
]

export function matchCommands(prefix: string): SlashCommand[] {
  const term = prefix.replace(/^\//, "").toLowerCase()
  if (term.length === 0) return COMMANDS
  return COMMANDS.filter((command) => command.name.startsWith(term))
}

export function helpText(): string {
  const width = Math.max(...COMMANDS.map((command) => command.name.length))
  return COMMANDS.map((command) => `  /${command.name.padEnd(width)}  ${command.description}`).join("\n")
}

export function runCommand(input: string): CommandEffect {
  const body = input.trim().replace(/^\//, "")
  const name = body.split(/\s+/)[0]?.toLowerCase() ?? ""
  switch (name) {
    case "help":
      return { kind: "notice", text: `commands:\n${helpText()}` }
    case "model":
      return { kind: "open-model-picker" }
    case "clear":
      return { kind: "clear" }
    case "resume":
      return { kind: "resume" }
    case "compact":
      return { kind: "compact" }
    case "plan":
      return { kind: "toggle-plan" }
    case "permissions":
      return { kind: "show-permissions" }
    case "mcp":
      return { kind: "show-mcp" }
    case "quit":
    case "exit":
      return { kind: "exit" }
    default:
      return { kind: "notice", text: `unknown command: /${name}`, tone: "warn" }
  }
}
