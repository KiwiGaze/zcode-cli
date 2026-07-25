import { test, expect } from "bun:test"
import { z } from "zod"
import { createSkillTool } from "@/skills/skill-tool"
import { defineTool, type AnyTool, type ToolContext } from "@/tools/registry"
import { okResult } from "@/tools/types"
import { FileState } from "@/tools/file-state"
import { testRuntime } from "../support/runtime"
import { testConfig, withApiKey } from "../support/config"
import { mockLLM } from "../support/mock-llm"
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

function forkSkill(over: Partial<Skill> & { name: string }): Skill {
  return {
    context: "fork",
    userInvocable: true,
    disableModelInvocation: false,
    source: "bundled",
    dir: "",
    location: "<bundled>",
    body: "do the work",
    ...over,
  }
}

function fakeTool(name: string): AnyTool {
  return defineTool<{ x?: string }>({
    name,
    description: name,
    inputSchema: z.object({ x: z.string().optional() }),
    permission: () => null,
    execute: async () => okResult("ok"),
  })
}

test("a fork skill runs in a subagent and returns its final text", async () => {
  const restore = withApiKey()
  try {
    const runtime = testRuntime(testConfig())
    const llm = mockLLM([{ text: "forked answer" }])
    runtime.llm = llm.fn
    const inheritedInstruction = "Use the inherited fork context."
    runtime.instructions = [{ path: "/tmp/AGENTS.md", content: inheritedInstruction }]
    runtime.skills = [forkSkill({ name: "research", description: "d" })]
    const result = await createSkillTool(runtime).execute({ name: "research" }, ctx())
    expect(result.status).toBe("ok")
    expect(result.output).toContain("forked answer")
    expect(result.title).toContain("forked")
    const childUserMessage = llm.calls[0]?.messages[0]
    expect(childUserMessage?.type).toBe("user")
    const childContext = childUserMessage?.type === "user" ? childUserMessage.content[0]?.text : undefined
    expect(childContext).toContain(inheritedInstruction)
    expect(childContext?.split("\n")).toContain("Working directory: /tmp")
  } finally {
    restore()
  }
})

test("a fork skill exposes read-only tools plus its grants, nothing else", async () => {
  const restore = withApiKey()
  try {
    const runtime = testRuntime(testConfig(), [fakeTool("read"), fakeTool("write")])
    const ungranted = mockLLM([{ text: "ok" }])
    runtime.llm = ungranted.fn
    runtime.skills = [forkSkill({ name: "plain", description: "d" })]
    await createSkillTool(runtime).execute({ name: "plain" }, ctx())
    const plainTools = ungranted.calls[0]?.tools.map((tool) => tool.name) ?? []
    expect(plainTools).toContain("read")
    expect(plainTools).not.toContain("write")

    const runtime2 = testRuntime(testConfig(), [fakeTool("read"), fakeTool("write")])
    const granted = mockLLM([{ text: "ok" }])
    runtime2.llm = granted.fn
    runtime2.skills = [forkSkill({ name: "writer", description: "d", allowedTools: ["write"] })]
    await createSkillTool(runtime2).execute({ name: "writer" }, ctx())
    const writerTools = granted.calls[0]?.tools.map((tool) => tool.name) ?? []
    expect(writerTools).toContain("write")
  } finally {
    restore()
  }
})
