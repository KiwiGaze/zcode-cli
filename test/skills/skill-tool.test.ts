import { test, expect } from "bun:test"
import { createSkillTool, isElevatingSkill } from "@/skills/skill-tool"
import type { ToolContext } from "@/tools/registry"
import { FileState } from "@/tools/file-state"
import { testRuntime } from "../support/runtime"
import { testConfig } from "../support/config"
import type { Skill } from "@/skills/types"

function ctx(): ToolContext {
  return {
    cwd: "/tmp",
    signal: new AbortController().signal,
    callId: "c1",
    sessionId: "ses_1",
    files: new FileState(),
    onProgress: () => {},
  }
}

function skill(over: Partial<Skill> & { name: string }): Skill {
  return {
    context: "inline",
    userInvocable: true,
    disableModelInvocation: false,
    source: "bundled",
    dir: "",
    location: "<bundled>",
    body: "",
    ...over,
  }
}

test("loads an inline skill body as output and records invocation metadata", async () => {
  const runtime = testRuntime(testConfig())
  runtime.skills = [skill({ name: "greet", description: "d", body: "Say hi to $ARGUMENTS" })]
  const result = await createSkillTool(runtime).execute({ name: "greet", args: "Ada" }, ctx())
  expect(result.status).toBe("ok")
  expect(result.output).toContain("Say hi to Ada")
  expect(result.metadata?.["invokedSkill"]).toEqual({ name: "greet", body: "Say hi to Ada" })
})

test("unknown skill returns an error listing available names", async () => {
  const runtime = testRuntime(testConfig())
  runtime.skills = [skill({ name: "known", description: "d", body: "x" })]
  const result = await createSkillTool(runtime).execute({ name: "nope" }, ctx())
  expect(result.status).toBe("error")
  expect(result.output).toContain("known")
})

test("a disable-model-invocation skill refuses model invocation", async () => {
  const runtime = testRuntime(testConfig())
  runtime.skills = [skill({ name: "manual", description: "d", body: "x", disableModelInvocation: true })]
  const result = await createSkillTool(runtime).execute({ name: "manual" }, ctx())
  expect(result.status).toBe("error")
  expect(result.output).toContain("/manual")
})

test("pure-text skills need no permission; elevating skills request one", () => {
  const runtime = testRuntime(testConfig())
  runtime.skills = [
    skill({ name: "pure", description: "d", body: "x" }),
    skill({ name: "deploy", description: "d", body: "x", allowedTools: ["bash(gh:*)"] }),
  ]
  const tool = createSkillTool(runtime)
  expect(tool.permission({ name: "pure" }, ctx())).toBeNull()
  const request = tool.permission({ name: "deploy" }, ctx())
  expect(request?.tool).toBe("skill")
  expect(request?.key).toBe("skill:deploy")
})

test("invoking an elevating inline skill grants its tools for the session", async () => {
  const runtime = testRuntime(testConfig())
  runtime.skills = [skill({ name: "deploy", description: "d", body: "go", allowedTools: ["bash(gh:*)"] })]
  await createSkillTool(runtime).execute({ name: "deploy" }, ctx())
  const outcome = runtime.permissions.evaluate({
    tool: "bash",
    callId: "c",
    title: "gh",
    key: "bash:gh",
    subject: "gh pr list",
  })
  expect(outcome).toBe("allow")
})

test("isElevatingSkill flags allowed-tools and fork", () => {
  expect(isElevatingSkill(skill({ name: "a", body: "" }))).toBe(false)
  expect(isElevatingSkill(skill({ name: "a", body: "", allowedTools: ["write"] }))).toBe(true)
  expect(isElevatingSkill(skill({ name: "a", body: "", context: "fork" }))).toBe(true)
})
