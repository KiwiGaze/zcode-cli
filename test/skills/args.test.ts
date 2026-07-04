import { test, expect } from "bun:test"
import { substituteArgs } from "@/skills/args"

const base = { skillDir: "/skills/demo", sessionId: "ses_1", names: [] as string[] }

test("$ARGUMENTS expands to the whole argument string", () => {
  expect(substituteArgs("Run: $ARGUMENTS", { ...base, raw: "a b c" })).toBe("Run: a b c")
})

test("positional $1 and $2 map to whitespace-split tokens", () => {
  expect(substituteArgs("$1 then $2", { ...base, raw: "first second" })).toBe("first then second")
})

test("named arguments map by the arguments list", () => {
  expect(substituteArgs("PR #$pr", { ...base, raw: "42", names: ["pr"] })).toBe("PR #42")
})

test("${SKILL_DIR} and ${SESSION_ID} expand", () => {
  expect(substituteArgs("${SKILL_DIR}:${SESSION_ID}", { ...base, raw: "" })).toBe("/skills/demo:ses_1")
})

test("unknown tokens and missing positionals are left or emptied safely", () => {
  expect(substituteArgs("$unknown", { ...base, raw: "" })).toBe("$unknown")
  expect(substituteArgs("[$1]", { ...base, raw: "" })).toBe("[]")
})
