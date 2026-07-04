import { test, expect } from "bun:test"
import { buildSystemPrompt } from "@/agent/system"
import { testConfig } from "../support/config"

test("system prompt includes environment and identity", () => {
  const prompt = buildSystemPrompt(testConfig({ cwd: "/work/app" }))
  expect(prompt).toContain("ZCode CLI")
  expect(prompt).toContain("/work/app")
})

test("plan mode adds the read-only directive", () => {
  const normal = buildSystemPrompt(testConfig(), [], false)
  const plan = buildSystemPrompt(testConfig(), [], true)
  expect(normal).not.toContain("Plan mode")
  expect(plan).toContain("Plan mode")
  expect(plan).toContain("Do NOT edit files")
})

test("instructions are appended as a project-instructions section", () => {
  const prompt = buildSystemPrompt(testConfig(), [{ path: "/work/AGENTS.md", content: "use tabs" }])
  expect(prompt).toContain("Project instructions")
  expect(prompt).toContain("use tabs")
  expect(prompt).toContain("/work/AGENTS.md")
})
