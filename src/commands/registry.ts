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
  | { kind: "show-skills"; reload: boolean }
  | { kind: "show-agents"; reload: boolean }
  | { kind: "run-skill"; name: string; args: string }
  | { kind: "run-goal"; condition: string }
  | { kind: "run-loop"; input: string }
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
  { name: "skills", description: "list agent skills" },
  { name: "agents", description: "list subagent types" },
  { name: "goal", description: "work until a condition is met" },
  { name: "loop", description: "repeat a prompt on an interval or self-paced" },
  { name: "quit", description: "exit ZCode CLI" },
]

export function matchCommands(prefix: string, skills: SlashCommand[] = []): SlashCommand[] {
  const term = prefix.replace(/^\//, "").toLowerCase()
  const all = [...COMMANDS, ...skills]
  if (term.length === 0) return all
  return all.filter((command) => command.name.toLowerCase().startsWith(term))
}

export function helpText(): string {
  const width = Math.max(...COMMANDS.map((command) => command.name.length))
  return COMMANDS.map((command) => `  /${command.name.padEnd(width)}  ${command.description}`).join("\n")
}

export function runCommand(input: string, skillNames: string[] = []): CommandEffect {
  const body = input.trim().replace(/^\//, "")
  const rawName = body.split(/\s+/)[0] ?? ""
  const name = rawName.toLowerCase()
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
    case "skills":
      return { kind: "show-skills", reload: body.split(/\s+/)[1]?.toLowerCase() === "reload" }
    case "agents":
      return { kind: "show-agents", reload: body.split(/\s+/)[1]?.toLowerCase() === "reload" }
    case "goal":
      return { kind: "run-goal", condition: body.slice(rawName.length).trim() }
    case "loop":
      return { kind: "run-loop", input: body.slice(rawName.length).trim() }
    case "quit":
    case "exit":
      return { kind: "exit" }
    default: {
      const skill = skillNames.find((candidate) => candidate === rawName || candidate.toLowerCase() === name)
      if (skill !== undefined) return { kind: "run-skill", name: skill, args: body.slice(rawName.length).trim() }
      return { kind: "notice", text: `unknown command: /${name}`, tone: "warn" }
    }
  }
}
