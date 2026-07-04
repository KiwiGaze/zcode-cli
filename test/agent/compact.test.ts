import { test, expect } from "bun:test"
import { projectForModel, shouldCompact, compact, estimatePromptTokens } from "@/agent/compact"
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
