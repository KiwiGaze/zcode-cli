import { test, expect } from "bun:test"
import { formatSkillCatalog } from "@/skills/catalog"
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

test("lists described, model-invocable skills under a header", () => {
  const out = formatSkillCatalog([skill({ name: "a", description: "does a" })], { budgetChars: 4000 })
  expect(out).toContain("# Available skills")
  expect(out).toContain("- a: does a")
})

test("omits skills with no description", () => {
  expect(formatSkillCatalog([skill({ name: "a" })], { budgetChars: 4000 })).toBe("")
})

test("omits disable-model-invocation skills", () => {
  const skills = [skill({ name: "a", description: "d", disableModelInvocation: true })]
  expect(formatSkillCatalog(skills, { budgetChars: 4000 })).toBe("")
})

test("appends when_to_use as a usage hint", () => {
  const out = formatSkillCatalog([skill({ name: "a", description: "d", whenToUse: "asked" })], { budgetChars: 4000 })
  expect(out).toContain("Use when asked")
})

test("a conditional-paths skill is hidden until an active path matches", () => {
  const conditional = skill({ name: "rust", description: "rust things", paths: ["**/*.rs"] })
  expect(formatSkillCatalog([conditional], { budgetChars: 4000 })).toBe("")
  const out = formatSkillCatalog([conditional], { budgetChars: 4000, activePaths: ["/repo/src/main.rs"] })
  expect(out).toContain("- rust: rust things")
})

test("degrades to names-only under a tiny budget", () => {
  const skills = [
    skill({ name: "alpha", description: "x".repeat(300) }),
    skill({ name: "beta", description: "y".repeat(300) }),
  ]
  const out = formatSkillCatalog(skills, { budgetChars: 40 })
  expect(out).toContain("- alpha")
  expect(out).toContain("- beta")
  expect(out).not.toContain("xxx")
})
