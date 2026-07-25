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

/**
 * Default-allow tools that reach the network. Auto mode downgrades them to `ask` so the classifier
 * sees every egress; any new tool of this kind belongs here, or it silently bypasses the classifier.
 */
const EGRESS_TOOLS = new Set(["webfetch"])

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

/** The tool a grant pattern applies to: `"bash(git:*)"` and `"bash"` both yield `"bash"`. */
export function grantToolName(pattern: string): string {
  const open = pattern.indexOf("(")
  return (open < 0 ? pattern : pattern.slice(0, open)).trim()
}

function grantPatternMatches(pattern: string, request: PermissionRequest): boolean {
  const open = pattern.indexOf("(")
  if (open < 0) return pattern.trim() === request.tool
  if (grantToolName(pattern) !== request.tool) return false
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
  private autoMode = false
  private autoConsecutiveDenials = 0
  private autoTotalDenials = 0

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

  setAutoMode(enabled: boolean): void {
    this.autoMode = enabled
  }

  isAutoMode(): boolean {
    return this.autoMode
  }

  /**
   * True once the refusal budget is spent, so the next classified action goes to a human instead.
   * Counters live on this instance, which every subagent shares, so a delegation chain cannot
   * reset the budget.
   */
  isAutoDenialLimitReached(): boolean {
    return (
      this.autoConsecutiveDenials >= this.config.autoMode.maxConsecutiveDenials ||
      this.autoTotalDenials >= this.config.autoMode.maxTotalDenials
    )
  }

  /** Record a classifier block. The block still stands; the limit governs the *next* action. */
  noteAutoDenial(): void {
    this.autoConsecutiveDenials += 1
    this.autoTotalDenials += 1
  }

  /** An allow — from the classifier or from a human decision — restores trust in the loop. */
  noteAutoAllow(): void {
    this.autoConsecutiveDenials = 0
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

    // An explicit user entry is intent and wins outright, as do the grants and bash rules above.
    // Only a *default* allow is downgraded for the classifier.
    const configured = this.config.permissions[request.tool]
    if (configured !== undefined) return configured
    if (this.autoMode && EGRESS_TOOLS.has(request.tool)) return "ask"

    return DEFAULT_TOOL_MODES[request.tool] ?? "ask"
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

  applyDecision(request: PermissionRequest, decision: PermissionDecision): void {
    if (decision === "allow-session") this.grantSession(request.key)
    if (decision !== "deny") this.noteAutoAllow()
  }
}

export function planModeDenyMessage(tool: string): string {
  return `plan mode is active — ${tool} is read-only here. Produce a written plan and wait for approval before editing.`
}
