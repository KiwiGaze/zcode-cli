import type { ResolvedConfig } from "@/config/config"

const DEFAULTS: Record<string, string> = {
  read: "allow",
  grep: "allow",
  glob: "allow",
  todowrite: "allow",
  webfetch: "allow",
  write: "ask",
  edit: "ask",
  bash: "ask",
}

export function permissionsSummary(config: ResolvedConfig): string {
  const tools = new Set([...Object.keys(DEFAULTS), ...Object.keys(config.permissions)])
  const lines = ["permissions:"]
  for (const tool of [...tools].sort()) {
    const mode = config.permissions[tool] ?? DEFAULTS[tool] ?? "ask"
    lines.push(`  ${tool.padEnd(10)} ${mode}`)
  }
  const rules = Object.entries(config.bashRules)
  if (rules.length > 0) {
    lines.push("bash rules:")
    for (const [rule, mode] of rules) lines.push(`  ${rule.padEnd(16)} ${mode}`)
  }
  return lines.join("\n")
}
