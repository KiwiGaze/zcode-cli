import type { PermissionMode, ResolvedConfig } from "@/config/config"
import type { PermissionDecision, PermissionRequest } from "@/permissions/types"

export type PolicyOutcome = "allow" | "ask" | "deny"

const DEFAULT_TOOL_MODES: Record<string, PermissionMode> = {
  read: "allow",
  grep: "allow",
  glob: "allow",
  todowrite: "allow",
  webfetch: "allow",
  memory: "allow",
  write: "ask",
  edit: "ask",
  bash: "ask",
  skill: "ask",
}

/** Wildcard match where `*` matches any run of characters. */
export function wildcardMatch(pattern: string, value: string): boolean {
  if (pattern === value) return true
  if (!pattern.includes("*")) return false
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
  return new RegExp(`^${escaped}$`).test(value)
}

/** A bash rule key matches a command if the command equals it, is prefixed by it, or matches its wildcard. */
export function bashRuleMatches(rule: string, command: string): boolean {
  const trimmedRule = rule.trim()
  if (trimmedRule.includes("*")) return wildcardMatch(trimmedRule, command)
  if (command === trimmedRule) return true
  return command.startsWith(`${trimmedRule} `)
}

/**
 * Does any skill grant pattern approve this request? `"write"` grants the whole tool; `"bash(gh:*)"`
 * or `"bash(git push)"` grants only matching bash commands (the `:*` suffix means "any subcommand").
 */
export function skillGrantMatches(patterns: string[], request: PermissionRequest): boolean {
  return patterns.some((pattern) => grantPatternMatches(pattern, request))
}

function grantPatternMatches(pattern: string, request: PermissionRequest): boolean {
  const open = pattern.indexOf("(")
  if (open < 0) return pattern.trim() === request.tool
  const tool = pattern.slice(0, open).trim()
  if (tool !== request.tool) return false
  const close = pattern.lastIndexOf(")")
  const inner = pattern.slice(open + 1, close < 0 ? undefined : close).trim()
  const prefixStar = /^(.*):\*$/.exec(inner)
  return prefixStar !== null
    ? bashRuleMatches(prefixStar[1] ?? "", request.subject)
    : bashRuleMatches(inner, request.subject)
}

export class PermissionEngine {
  private sessionAllowed = new Set<string>()
  private skillGrants: string[] = []
  private planMode = false

  constructor(private config: ResolvedConfig) {}

  setConfig(config: ResolvedConfig): void {
    this.config = config
  }

  setPlanMode(enabled: boolean): void {
    this.planMode = enabled
  }

  isPlanMode(): boolean {
    return this.planMode
  }

  grantSession(key: string): void {
    this.sessionAllowed.add(key)
  }

  /** Add temporary tool grants from an elevating skill's `allowed-tools` (session-scoped). */
  grantSkillTools(patterns: string[]): void {
    for (const pattern of patterns) this.skillGrants.push(pattern)
  }

  isMutating(tool: string): boolean {
    return tool === "write" || tool === "edit" || tool === "bash"
  }

  evaluate(request: PermissionRequest): PolicyOutcome {
    if (this.sessionAllowed.has(request.key)) return "allow"
    if (this.planMode && this.isMutating(request.tool)) return "deny"
    if (skillGrantMatches(this.skillGrants, request)) return "allow"

    if (request.tool === "bash") {
      const ruleOutcome = this.bashRuleOutcome(request.subject)
      if (ruleOutcome !== undefined) return ruleOutcome
    }

    return this.toolMode(request.tool)
  }

  private bashRuleOutcome(command: string): PolicyOutcome | undefined {
    let matched: PolicyOutcome | undefined
    let matchedLength = -1
    for (const [rule, mode] of Object.entries(this.config.bashRules)) {
      if (!bashRuleMatches(rule, command)) continue
      if (rule.length > matchedLength) {
        matched = mode
        matchedLength = rule.length
      }
    }
    return matched
  }

  private toolMode(tool: string): PolicyOutcome {
    return this.config.permissions[tool] ?? DEFAULT_TOOL_MODES[tool] ?? "ask"
  }

  applyDecision(request: PermissionRequest, decision: PermissionDecision): void {
    if (decision === "allow-session") this.grantSession(request.key)
  }
}

export function planModeDenyMessage(tool: string): string {
  return `plan mode is active — ${tool} is read-only here. Produce a written plan and wait for approval before editing.`
}
