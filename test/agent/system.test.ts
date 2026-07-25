import { test, expect } from "bun:test"
import { buildSystemPrompt } from "@/agent/system"

test("system prompt contains only the universal identity", () => {
  const prompt = buildSystemPrompt()
  expect(prompt).toContain("ZCode CLI")
  expect(prompt).not.toContain("# Environment")
  expect(prompt).not.toContain("# Plan mode")
  expect(prompt).not.toContain("# Project instructions")
  expect(prompt).not.toContain("# Available skills")
})
