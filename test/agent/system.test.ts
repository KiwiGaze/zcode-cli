import { test, expect } from "bun:test"
import { buildSystemPrompt } from "@/agent/system"
import { testConfig } from "../support/config"
import type { Skill } from "@/skills/types"

function skill(over: Partial<Skill> & { name: string }): Skill {
  return {
    context: "inline",
    userInvocable: true,
    disableModelInvocation: false,
    source: "disk",
    dir: "/d",
    location: "/d/SKILL.md",
    body: "",
    ...over,
  }
}

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

test("the skills catalog lists advertised skills; conditional ones need an active path", () => {
  const skills = [
    skill({ name: "always", description: "always shown" }),
    skill({ name: "rusty", description: "rust only", paths: ["**/*.rs"] }),
  ]
  const bare = buildSystemPrompt(testConfig(), [], false, skills)
  expect(bare).toContain("# Available skills")
  expect(bare).toContain("- always: always shown")
  expect(bare).not.toContain("rusty")

  const active = buildSystemPrompt(testConfig(), [], false, skills, ["/x/main.rs"])
  expect(active).toContain("- rusty: rust only")
})

test("no skills section is emitted when nothing is advertised", () => {
  expect(buildSystemPrompt(testConfig(), [], false, [])).not.toContain("# Available skills")
})
