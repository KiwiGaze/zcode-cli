import { test, expect } from "bun:test"
import { PermissionEngine, bashRuleMatches, wildcardMatch } from "@/permissions/policy"
import type { PermissionRequest } from "@/permissions/types"
import { testConfig } from "../support/config"

function bashRequest(command: string): PermissionRequest {
  return { tool: "bash", callId: "c1", title: command, key: `bash:${command.split(" ")[0]}`, subject: command }
}

test("wildcardMatch handles trailing wildcard", () => {
  expect(wildcardMatch("rm *", "rm -rf x")).toBe(true)
  expect(wildcardMatch("rm *", "git status")).toBe(false)
})

test("bashRuleMatches prefix and wildcard", () => {
  expect(bashRuleMatches("git status", "git status")).toBe(true)
  expect(bashRuleMatches("git status", "git status --short")).toBe(true)
  expect(bashRuleMatches("git", "gitk")).toBe(false)
  expect(bashRuleMatches("rm *", "rm file")).toBe(true)
})

test("default tool modes: read allow, edit ask", () => {
  const engine = new PermissionEngine(testConfig())
  expect(engine.evaluate({ tool: "read", callId: "c", title: "read", key: "read:x", subject: "x" })).toBe("allow")
  expect(engine.evaluate({ tool: "edit", callId: "c", title: "edit", key: "edit:x", subject: "x" })).toBe("ask")
})

test("bash rules override the default bash mode", () => {
  const config = testConfig({ bashRules: { "git status": "allow", "rm *": "deny" } })
  const engine = new PermissionEngine(config)
  expect(engine.evaluate(bashRequest("git status"))).toBe("allow")
  expect(engine.evaluate(bashRequest("rm -rf node_modules"))).toBe("deny")
  expect(engine.evaluate(bashRequest("npm test"))).toBe("ask")
})

test("longest matching bash rule wins", () => {
  const config = testConfig({ bashRules: { git: "deny", "git status": "allow" } })
  const engine = new PermissionEngine(config)
  expect(engine.evaluate(bashRequest("git status"))).toBe("allow")
  expect(engine.evaluate(bashRequest("git push"))).toBe("deny")
})

test("session grant makes a repeated key auto-allow", () => {
  const engine = new PermissionEngine(testConfig())
  const request: PermissionRequest = { tool: "edit", callId: "c", title: "edit", key: "edit:/a", subject: "/a" }
  expect(engine.evaluate(request)).toBe("ask")
  engine.applyDecision(request, "allow-session")
  expect(engine.evaluate(request)).toBe("allow")
})

test("plan mode denies mutating tools but allows reads", () => {
  const engine = new PermissionEngine(testConfig())
  engine.setPlanMode(true)
  expect(engine.evaluate({ tool: "edit", callId: "c", title: "edit", key: "edit:/a", subject: "/a" })).toBe("deny")
  expect(engine.evaluate(bashRequest("ls"))).toBe("deny")
  expect(engine.evaluate({ tool: "read", callId: "c", title: "read", key: "read:/a", subject: "/a" })).toBe("allow")
})
