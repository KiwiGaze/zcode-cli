import { test, expect } from "bun:test"
import { projectForModel, shouldCompact, compact, estimatePromptTokens, recordInvokedSkill } from "@/agent/compact"
import { createSession } from "@/session/session"
import { userMessage, type AssistantMessage } from "@/session/messages"
import type { CompactionRecord } from "@/session/store"
import { mockLLM } from "../support/mock-llm"
import { testConfig, withApiKey } from "../support/config"

function assistant(id: string, text: string, inputTokens = 0): AssistantMessage {
  return {
    type: "assistant",
    id,
    ts: 1,
    provider: "zai",
    model: "glm-5.2",
    parts: [{ type: "text", text }],
    usage: { input: inputTokens, output: 5, reasoning: 0, cachedInput: 0 },
    stopReason: "end",
  }
}

test("projectForModel returns items unchanged when there is no compaction", () => {
  const session = createSession("/tmp")
  session.items = [userMessage("u1", "hi"), assistant("a1", "hello")]
  expect(projectForModel(session, [])).toEqual(session.items)
})

test("projectForModel folds items up to the covered message into a summary", () => {
  const session = createSession("/tmp")
  session.items = [
    userMessage("u1", "first"),
    assistant("a1", "answer one"),
    userMessage("u2", "second"),
    assistant("a2", "answer two"),
  ]
  const compactions: CompactionRecord[] = [{ type: "compaction", summary: "earlier stuff", coversUpTo: "a1" }]
  const projected = projectForModel(session, compactions)
  expect(projected).toHaveLength(3)
  expect(projected[0]?.type).toBe("user")
  expect(projected[0]?.type === "user" ? projected[0].content[0]?.text : "").toContain("earlier stuff")
  expect(projected[1]?.type === "user" ? projected[1].content[0]?.text : "").toBe("second")
})

test("shouldCompact triggers when the last prompt exceeds the threshold", () => {
  const config = testConfig({ compaction: { threshold: 0.8 }, models: { "glm-5.2": { context: 1000, maxOutput: 100 } } })
  const session = createSession("/tmp")
  session.items = [userMessage("u1", "hi"), assistant("a1", "reply", 900)]
  expect(shouldCompact(session, config, [])).toBe(true)

  session.items = [userMessage("u2", "hi"), assistant("a2", "reply", 100)]
  expect(shouldCompact(session, config, [])).toBe(false)
})

test("estimatePromptTokens scales with content length", () => {
  const session = createSession("/tmp")
  session.items = [userMessage("u1", "x".repeat(400))]
  expect(estimatePromptTokens(session.items)).toBe(100)
})

test("compact produces a record covering the older turns", async () => {
  const restore = withApiKey()
  try {
    const config = testConfig()
    const session = createSession("/tmp")
    session.items = [
      userMessage("u1", "first task"),
      assistant("a1", "did first"),
      userMessage("u2", "second task"),
      assistant("a2", "did second"),
      userMessage("u3", "third task"),
    ]
    const llm = mockLLM([{ text: "## Goal\nbuild things\n## Next steps\nkeep going" }])
    const compactions: CompactionRecord[] = []
    const record = await compact(session, config, compactions, new AbortController().signal, { llm: llm.fn })
    expect(record).not.toBeNull()
    expect(record?.summary).toContain("build things")
    expect(compactions).toHaveLength(1)
    // the retained tail (last user turn) stays verbatim after projection
    const projected = projectForModel(session, compactions)
    expect(projected[projected.length - 1]?.type === "user" ? projected[projected.length - 1] : null).not.toBeNull()
  } finally {
    restore()
  }
})

test("recordInvokedSkill dedupes by name and keeps the newest few", () => {
  const session = createSession("/tmp")
  for (let i = 0; i < 6; i++) recordInvokedSkill(session, { name: `s${i}`, body: "b", itemId: `a${i}` })
  expect(session.invokedSkills).toHaveLength(4)
  recordInvokedSkill(session, { name: "s5", body: "updated", itemId: "a5b" })
  expect(session.invokedSkills.filter((skill) => skill.name === "s5")).toHaveLength(1)
  expect(session.invokedSkills.at(-1)?.body).toBe("updated")
})

function textOf(items: ReturnType<typeof projectForModel>): string[] {
  return items.map((item) => (item.type === "user" ? item.content.map((part) => part.text).join("") : ""))
}

test("projectForModel re-injects a folded skill body right after the summary", () => {
  const session = createSession("/tmp")
  session.items = [
    userMessage("u1", "first"),
    assistant("a1", "invoked a skill"),
    userMessage("u2", "second"),
    assistant("a2", "answer"),
  ]
  session.invokedSkills = [{ name: "flow", body: "STEP INSTRUCTIONS", itemId: "a1" }]
  const compactions: CompactionRecord[] = [{ type: "compaction", summary: "s", coversUpTo: "a1" }]
  const texts = textOf(projectForModel(session, compactions, session.invokedSkills))
  expect(texts[1]).toContain("active-skills")
  expect(texts[1]).toContain("STEP INSTRUCTIONS")
})

test("projectForModel does not re-inject a skill still in the retained tail", () => {
  const session = createSession("/tmp")
  session.items = [
    userMessage("u1", "first"),
    assistant("a1", "old"),
    userMessage("u2", "second"),
    assistant("a2", "invoked a skill here"),
  ]
  session.invokedSkills = [{ name: "flow", body: "STEP INSTRUCTIONS", itemId: "a2" }]
  const compactions: CompactionRecord[] = [{ type: "compaction", summary: "s", coversUpTo: "a1" }]
  const texts = textOf(projectForModel(session, compactions, session.invokedSkills))
  expect(texts.some((text) => text.includes("active-skills"))).toBe(false)
})
