import { test, expect } from "bun:test"
import { parseAgentFile } from "@/subagents/frontmatter"
import { isElevatingAgent, type AgentDefinition } from "@/subagents/types"

function agent(over: Partial<AgentDefinition>): AgentDefinition {
  return { name: "a", description: "d", prompt: "p", source: "disk", location: "/tmp/a.md", ...over }
}

test("parses a valid agent file", () => {
  const parsed = parseAgentFile(
    [
      "---",
      "name: Security Review",
      "description: audits a diff",
      "allowed-tools: read, bash(git:*)",
      "model: glm-4.7",
      "---",
      "",
      "You audit diffs.",
      "Be terse.",
    ].join("\n"),
  )

  expect(parsed.displayName).toBe("Security Review")
  expect(parsed.description).toBe("audits a diff")
  expect(parsed.allowedTools).toEqual(["read", "bash(git:*)"])
  expect(parsed.model).toBe("glm-4.7")
  expect(parsed.body).toBe("You audit diffs.\nBe terse.")
})

test("accepts a YAML list for allowed-tools as well as a comma string", () => {
  const asList = parseAgentFile(
    ["---", "description: d", "allowed-tools:", "  - read", "  - grep", "---", "body"].join("\n"),
  )
  expect(asList.allowedTools).toEqual(["read", "grep"])

  const asString = parseAgentFile(["---", "description: d", "allowed-tools: read,grep", "---", "body"].join("\n"))
  expect(asString.allowedTools).toEqual(["read", "grep"])
})

test("accepts the Claude Code tools: key", () => {
  const parsed = parseAgentFile(
    ["---", "description: interop agent", "tools: read, bash(git:*)", "---", "body"].join("\n"),
  )
  expect(parsed.allowedTools).toEqual(["read", "bash(git:*)"])
})

test("rejects a file that sets both tools and allowed-tools", () => {
  const raw = ["---", "description: d", "tools: read", "allowed-tools: grep", "---", "body"].join("\n")
  expect(() => parseAgentFile(raw)).toThrow(/both 'tools' and 'allowed-tools'/)
})

test("rejects malformed frontmatter with the reason", () => {
  expect(() => parseAgentFile(["---", "- just", "- a list", "---", "body"].join("\n"))).toThrow(/mapping/)
  expect(() => parseAgentFile(["---", "description: 42", "---", "body"].join("\n"))).toThrow(/invalid frontmatter/)
})

test("a file with no frontmatter is all body", () => {
  const parsed = parseAgentFile("just a prompt\n")
  expect(parsed.body).toBe("just a prompt")
  expect(parsed.description).toBeUndefined()
  expect(parsed.allowedTools).toBeUndefined()
})

test("an agent elevates only when it grants beyond the read-only base", () => {
  expect(isElevatingAgent(agent({ allowedTools: undefined }))).toBe(false)
  expect(isElevatingAgent(agent({ allowedTools: ["read", "grep", "glob", "webfetch"] }))).toBe(false)
  expect(isElevatingAgent(agent({ allowedTools: ["read", "bash(git:*)"] }))).toBe(true)
  expect(isElevatingAgent(agent({ allowedTools: ["write"] }))).toBe(true)
  expect(isElevatingAgent(agent({ allowedTools: ["edit"] }))).toBe(true)
})
