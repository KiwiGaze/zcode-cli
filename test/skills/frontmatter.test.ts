import { test, expect } from "bun:test"
import { parseSkillFile } from "@/skills/frontmatter"

test("parses core fields with hyphen and snake_case aliases", () => {
  const parsed = parseSkillFile(
    [
      "---",
      "name: review",
      "description: Review a diff",
      "when_to_use: the user asks for review",
      "allowed-tools: [bash(gh:*), write]",
      "argument-hint: <pr>",
      "arguments: [pr]",
      "user-invocable: false",
      "disable-model-invocation: true",
      "context: fork",
      'paths: ["**/*.rs"]',
      "---",
      "Body line one.",
    ].join("\n"),
  )
  expect(parsed.description).toBe("Review a diff")
  expect(parsed.whenToUse).toBe("the user asks for review")
  expect(parsed.allowedTools).toEqual(["bash(gh:*)", "write"])
  expect(parsed.argumentHint).toBe("<pr>")
  expect(parsed.arguments).toEqual(["pr"])
  expect(parsed.userInvocable).toBe(false)
  expect(parsed.disableModelInvocation).toBe(true)
  expect(parsed.context).toBe("fork")
  expect(parsed.paths).toEqual(["**/*.rs"])
  expect(parsed.body).toBe("Body line one.")
})

test("applies defaults when frontmatter is minimal", () => {
  const parsed = parseSkillFile("---\ndescription: minimal\n---\nbody")
  expect(parsed.context).toBe("inline")
  expect(parsed.userInvocable).toBe(true)
  expect(parsed.disableModelInvocation).toBe(false)
  expect(parsed.allowedTools).toBeUndefined()
})

test("coerces a single string into a one-item list", () => {
  const parsed = parseSkillFile("---\nallowed-tools: write\n---\nbody")
  expect(parsed.allowedTools).toEqual(["write"])
})

test("treats a file with no frontmatter as all body", () => {
  const parsed = parseSkillFile("just instructions, no frontmatter")
  expect(parsed.body).toBe("just instructions, no frontmatter")
  expect(parsed.description).toBeUndefined()
})

test("throws on a wrong-typed field", () => {
  expect(() => parseSkillFile("---\ndescription: [1, 2]\n---\nbody")).toThrow(/invalid frontmatter/)
})

test("throws when frontmatter is not a mapping", () => {
  expect(() => parseSkillFile("---\n- just\n- a\n- list\n---\nbody")).toThrow(/mapping/)
})
