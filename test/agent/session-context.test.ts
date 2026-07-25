import { expect, test } from "bun:test"
import { query } from "@/agent/query"
import { buildSessionContext, withSessionContext, type SessionContextInput } from "@/agent/session-context"
import type { AgentEvent } from "@/agent/events"
import { toModelMessages } from "@/llm/stream"
import {
  userMessage,
  type AssistantMessage,
  type ChatItem,
  type ToolResultItem,
  type UserMessage,
} from "@/session/messages"
import { createSession } from "@/session/session"
import type { Skill } from "@/skills/types"
import { mockLLM, type MockCall } from "../support/mock-llm"
import { testConfig, withApiKey } from "../support/config"
import { testRuntime } from "../support/runtime"

const BASE_CONTEXT: SessionContextInput = {
  cwd: "/work/app",
  platform: "darwin",
  platformRelease: "25.0.0",
  date: "Fri Jul 24 2026",
  skillCatalogBudgetChars: 4_000,
  instructions: [{ path: "/work/app/AGENTS.md", content: "Use domain names." }],
  planMode: false,
  skills: [],
  activePaths: [],
}

function skill(overrides: Partial<Skill> & { name: string }): Skill {
  return {
    context: "inline",
    userInvocable: true,
    disableModelInvocation: false,
    source: "disk",
    dir: "/skills",
    location: "/skills/SKILL.md",
    body: "",
    ...overrides,
  }
}

function assistant(id: string): AssistantMessage {
  return {
    type: "assistant",
    id,
    ts: 1,
    provider: "zai",
    model: "glm-5.2",
    parts: [{ type: "text", text: "answer" }],
    usage: { input: 1, output: 1, reasoning: 0, cachedInput: 0 },
    stopReason: "end",
  }
}

async function drain(events: AsyncGenerator<AgentEvent, void>): Promise<void> {
  for await (const _event of events) {
  }
}

function firstUserMessage(call: MockCall | undefined): UserMessage {
  const message = call?.messages[0]
  if (message?.type !== "user") throw new Error("Expected the first projected message to be a user message.")
  return message
}

test("the system head is identical across projects, modes, and turns", async () => {
  const restore = withApiKey()
  try {
    const configA = testConfig({ cwd: "/work/a" })
    const runtimeA = testRuntime(configA)
    runtimeA.instructions = [{ path: "/work/a/AGENTS.md", content: "Instruction A" }]
    const sessionA = createSession(configA.cwd)

    const configB = testConfig({ cwd: "/work/b" })
    const runtimeB = testRuntime(configB)
    runtimeB.instructions = [{ path: "/work/b/AGENTS.md", content: "Instruction B" }]
    runtimeB.permissions.setPlanMode(true)
    const sessionB = createSession(configB.cwd)

    const llm = mockLLM([{ text: "one" }, { text: "two" }, { text: "three" }])
    const signal = new AbortController().signal
    await drain(
      query({ prompt: "first", session: sessionA, config: configA, runtime: runtimeA, signal, deps: { llm: llm.fn } }),
    )
    await drain(
      query({ prompt: "second", session: sessionA, config: configA, runtime: runtimeA, signal, deps: { llm: llm.fn } }),
    )
    await drain(
      query({ prompt: "third", session: sessionB, config: configB, runtime: runtimeB, signal, deps: { llm: llm.fn } }),
    )

    const systems = llm.calls.map((call) => call.system)
    expect(systems).toHaveLength(3)
    expect(systems[1]).toBe(systems[0])
    expect(systems[2]).toBe(systems[0])
    expect(systems[0]).toContain("ZCode CLI")
    expect(systems[0]).not.toContain("/work/a")
    expect(systems[0]).not.toContain("Instruction A")
    expect(systems[0]).not.toContain("# Plan mode")
    expect(firstUserMessage(llm.calls[0]).content[0]?.text).not.toContain("# Plan mode")
    expect(firstUserMessage(llm.calls[2]).content[0]?.text).toContain("# Plan mode")
    expect(firstUserMessage(llm.calls[2]).content[0]?.text).toContain("Do NOT edit files")
  } finally {
    restore()
  }
})

test("volatile context rides the first user message and stays byte-stable across turns", async () => {
  const restore = withApiKey()
  try {
    const config = testConfig({ cwd: "/work/app" })
    const runtime = testRuntime(config)
    runtime.instructions = [{ path: "/work/app/AGENTS.md", content: "Use domain names." }]
    runtime.skills = [skill({ name: "review", description: "Review changes" })]
    const session = createSession(config.cwd)
    const llm = mockLLM([{ text: "one" }, { text: "two" }])
    const signal = new AbortController().signal

    await drain(query({ prompt: "first prompt", session, config, runtime, signal, deps: { llm: llm.fn } }))
    await drain(query({ prompt: "second prompt", session, config, runtime, signal, deps: { llm: llm.fn } }))

    const first = firstUserMessage(llm.calls[0])
    const second = firstUserMessage(llm.calls[1])
    expect(first.content[0]?.text).toContain("Working directory: /work/app")
    expect(first.content[0]?.text).toContain("Use domain names.")
    expect(first.content[0]?.text).toContain("- review: Review changes")
    expect(first.content.at(-1)?.text).toBe("first prompt")
    expect(second).toEqual(first)
  } finally {
    restore()
  }
})

test("the context renderer changes only when its explicit inputs change", () => {
  const first = buildSessionContext(BASE_CONTEXT)
  const second = buildSessionContext(BASE_CONTEXT)
  const plan = buildSessionContext({ ...BASE_CONTEXT, planMode: true })

  expect(second).toBe(first)
  expect(plan).not.toBe(first)
  expect(first).toContain("# Environment")
  expect(first).toContain("Platform: darwin (25.0.0)")
  expect(first).toContain("Date: Fri Jul 24 2026")
  expect(first).toContain("# Project instructions")
  expect(plan).toContain("Do NOT edit files")
})

test("conditional skill activation changes the context once and then restabilizes", async () => {
  const restore = withApiKey()
  try {
    const config = testConfig()
    const runtime = testRuntime(config)
    runtime.skills = [skill({ name: "rust", description: "Rust workflow", paths: ["**/*.rs"] })]
    const session = createSession(config.cwd)
    const llm = mockLLM([{ text: "one" }, { text: "two" }, { text: "three" }])
    const signal = new AbortController().signal

    await drain(query({ prompt: "first", session, config, runtime, signal, deps: { llm: llm.fn } }))
    runtime.files.markTouched("/work/main.rs")
    await drain(query({ prompt: "second", session, config, runtime, signal, deps: { llm: llm.fn } }))
    await drain(query({ prompt: "third", session, config, runtime, signal, deps: { llm: llm.fn } }))

    const before = firstUserMessage(llm.calls[0]).content[0]?.text
    const activated = firstUserMessage(llm.calls[1]).content[0]?.text
    const stable = firstUserMessage(llm.calls[2]).content[0]?.text
    expect(before).not.toContain("- rust: Rust workflow")
    expect(activated).toContain("- rust: Rust workflow")
    expect(stable).toBe(activated)
  } finally {
    restore()
  }
})

test("compaction keeps context ahead of the synthesized summary", async () => {
  const restore = withApiKey()
  try {
    const config = testConfig()
    const runtime = testRuntime(config)
    const session = createSession(config.cwd)
    const llm = mockLLM([{ text: "first answer" }, { text: "second answer" }])
    const signal = new AbortController().signal

    await drain(query({ prompt: "first prompt", session, config, runtime, signal, deps: { llm: llm.fn } }))
    const firstAssistant = session.items.find((item) => item.type === "assistant")
    if (firstAssistant === undefined) throw new Error("Expected the first turn to record an assistant message.")
    runtime.compactions = [{ type: "compaction", summary: "Earlier work summary", coversUpTo: firstAssistant.id }]
    await drain(query({ prompt: "second prompt", session, config, runtime, signal, deps: { llm: llm.fn } }))

    const before = firstUserMessage(llm.calls[0])
    const compacted = firstUserMessage(llm.calls[1])
    expect(compacted.content[0]?.text).toBe(before.content[0]?.text)
    expect(compacted.content[1]?.text).toContain("<conversation-summary>")
    expect(compacted.content[1]?.text).toContain("Earlier work summary")
  } finally {
    restore()
  }
})

test("session history stays free of the projection-only context", async () => {
  const restore = withApiKey()
  try {
    const config = testConfig()
    const runtime = testRuntime(config)
    const session = createSession(config.cwd)
    const llm = mockLLM([{ text: "answer" }])

    await drain(
      query({
        prompt: "raw prompt",
        session,
        config,
        runtime,
        signal: new AbortController().signal,
        deps: { llm: llm.fn },
      }),
    )

    const stored = session.items[0]
    expect(stored?.type).toBe("user")
    expect(stored?.type === "user" ? stored.content : undefined).toEqual([{ type: "text", text: "raw prompt" }])
    expect(firstUserMessage(llm.calls[0]).content).toHaveLength(2)
  } finally {
    restore()
  }
})

test("withSessionContext rewrites only the first user item", () => {
  const firstAssistant = assistant("a1")
  const firstUser = userMessage("u1", "first")
  const toolResult: ToolResultItem = {
    type: "tool-result",
    callId: "c1",
    name: "read",
    result: { status: "ok", output: "file" },
  }
  const secondUser = userMessage("u2", "second")
  const items: ChatItem[] = [firstAssistant, firstUser, toolResult, secondUser]

  const projected = withSessionContext(items, "context")

  expect(projected).not.toBe(items)
  expect(projected.map((item) => item.type)).toEqual(items.map((item) => item.type))
  expect(projected[0]).toBe(firstAssistant)
  expect(projected[1]).not.toBe(firstUser)
  expect(projected[2]).toBe(toolResult)
  expect(projected[3]).toBe(secondUser)
  expect(projected[1]?.type === "user" ? projected[1].content : undefined).toEqual([
    { type: "text", text: "context\n\n" },
    { type: "text", text: "first" },
  ])
  expect(firstUser.content).toEqual([{ type: "text", text: "first" }])
  expect(withSessionContext(items, "")).toBe(items)
  const noUser: ChatItem[] = [firstAssistant, toolResult]
  expect(withSessionContext(noUser, "context")).toBe(noUser)
})

test("the provider receives context before prompt content in the first user message", () => {
  const projected = withSessionContext([userMessage("u1", "raw prompt")], "session context")

  expect(toModelMessages(projected)).toEqual([
    {
      role: "user",
      content: "session context\n\nraw prompt",
    },
  ])
})
