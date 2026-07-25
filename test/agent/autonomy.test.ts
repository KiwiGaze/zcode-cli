import { test, expect } from "bun:test"
import { clampWakeupDelay, parseGoalVerdict, parseLoopInput, projectGoalTranscript } from "@/agent/autonomy"
import type { AssistantPart, ChatItem } from "@/session/messages"
import { EMPTY_USAGE } from "@/session/messages"

function user(id: string, text: string): ChatItem {
  return { type: "user", id, ts: 1, content: [{ type: "text", text }] }
}

function assistant(id: string, parts: AssistantPart[]): ChatItem {
  return {
    type: "assistant",
    id,
    ts: 1,
    provider: "zai",
    model: "glm-5.2",
    parts,
    usage: { ...EMPTY_USAGE },
    stopReason: "end",
  }
}

function toolResult(callId: string, name: string, output: string): ChatItem {
  return { type: "tool-result", callId, name, result: { status: "ok", output } }
}

test("parseLoopInput classifies leading interval, trailing every-phrase, and dynamic prompts", () => {
  expect(parseLoopInput("5m check CI")).toEqual({
    mode: "interval",
    prompt: "check CI",
    intervalSeconds: 300,
    intervalLabel: "5m",
  })
  expect(parseLoopInput("check CI every 5 minutes")).toMatchObject({
    mode: "interval",
    prompt: "check CI",
    intervalSeconds: 300,
  })
  expect(parseLoopInput("2h rebuild the docs")).toMatchObject({ mode: "interval", intervalSeconds: 7200 })
  expect(parseLoopInput("1d nightly sweep")).toMatchObject({ mode: "interval", intervalSeconds: 86_400 })

  // "every" without a following time expression must stay dynamic.
  expect(parseLoopInput("check every PR")).toEqual({ mode: "dynamic", prompt: "check every PR" })
  expect(parseLoopInput("watch the deploy")).toEqual({ mode: "dynamic", prompt: "watch the deploy" })

  // A bare interval with no task is a usage error, not a prompt that mentions minutes.
  expect(parseLoopInput("every 5 minutes")).toEqual({ error: "usage: /loop [interval] <prompt>" })
  expect(parseLoopInput("")).toEqual({ error: "usage: /loop [interval] <prompt>" })
  expect(parseLoopInput("   ")).toEqual({ error: "usage: /loop [interval] <prompt>" })
  expect(parseLoopInput("5m")).toEqual({ error: "usage: /loop [interval] <prompt>" })
  expect(parseLoopInput("0s do a thing")).toEqual({ error: "/loop interval must be positive" })
})

test("clampWakeupDelay bounds the model's chosen pace to [60, 3600]", () => {
  expect(clampWakeupDelay(5)).toBe(60)
  expect(clampWakeupDelay(0)).toBe(60)
  expect(clampWakeupDelay(-100)).toBe(60)
  expect(clampWakeupDelay(7200)).toBe(3600)
  expect(clampWakeupDelay(300)).toBe(300)
  expect(clampWakeupDelay(90.6)).toBe(91)
  expect(clampWakeupDelay(Number.NaN)).toBe(60)
  expect(clampWakeupDelay(Number.POSITIVE_INFINITY)).toBe(60)
})

test("parseGoalVerdict is fail-closed", () => {
  expect(parseGoalVerdict('{"ok":true,"reason":"tests pass"}')).toEqual({
    ok: true,
    reason: "tests pass",
    impossible: false,
  })
  expect(parseGoalVerdict('```json\n{"ok":true,"reason":"green"}\n```')).toMatchObject({ ok: true })
  expect(parseGoalVerdict('Sure. {"ok":true,"reason":"green"} Hope that helps.')).toMatchObject({ ok: true })

  // Every rejection path returns ok: false — a broken evaluator can never clear a goal.
  const rejected = [
    '{"ok":true}',
    '{"ok":true,"reason":""}',
    '{"ok":true,"reason":"   "}',
    '{"ok":true,"impossible":true,"reason":"contradiction"}',
    '{"reason":"no ok field"}',
    '{"ok":"yes","reason":"x"}',
    '{"ok":1,"reason":"x"}',
    "not json at all",
    "",
    '{"ok":true,"reason":"unterminated',
    "[]",
  ]
  for (const raw of rejected) expect(parseGoalVerdict(raw).ok).toBe(false)

  expect(parseGoalVerdict('{"ok":false,"impossible":true,"reason":"the file does not exist"}')).toEqual({
    ok: false,
    reason: "the file does not exist",
    impossible: true,
  })
  // A rejected contradiction is never reported as impossible either.
  expect(parseGoalVerdict('{"ok":true,"impossible":true,"reason":"r"}').impossible).toBe(false)
  // Extra keys are tolerated.
  expect(parseGoalVerdict('{"ok":true,"reason":"r","extra":42}')).toMatchObject({ ok: true })
})

test("projectGoalTranscript scopes to the last turn and bounds output", () => {
  const items: ChatItem[] = [
    user("u1", "first request"),
    assistant("a1", [{ type: "text", text: "OLD ANSWER" }]),
    toolResult("c0", "read", "OLD TOOL OUTPUT"),
    user("u2", "second request"),
    assistant("a2", [
      { type: "text", text: "running the suite" },
      { type: "tool-call", callId: "c1", name: "bash", input: { command: "bun test" } },
    ]),
    toolResult("c1", "bash", "x".repeat(5000)),
  ]

  const projection = projectGoalTranscript(items)

  // Only the last turn is evidence.
  expect(projection).not.toContain("OLD ANSWER")
  expect(projection).not.toContain("OLD TOOL OUTPUT")
  expect(projection).not.toContain("second request")
  expect(projection).toContain("running the suite")
  expect(projection).toContain('ASSISTANT called bash({"command":"bun test"})')
  // Tool output is clipped to 500 chars.
  expect(projection).toContain("TOOL bash -> ")
  expect(projection).not.toContain("x".repeat(501))

  // A huge turn trips the total cap with a visible marker, and stays inside the 16k budget the
  // evaluator prompt is built around — the marker itself must not push it back over.
  const huge: ChatItem[] = [user("u1", "go"), assistant("a1", [{ type: "text", text: "y".repeat(20_000) }])]
  const capped = projectGoalTranscript(huge)
  expect(capped.length).toBeLessThanOrEqual(16_000)
  expect(capped).toMatch(/…\[\d+ chars\]…/)
})

test("projectGoalTranscript handles a turn with no assistant output", () => {
  expect(projectGoalTranscript([])).toBe("")
  expect(projectGoalTranscript([user("u1", "only a user message")])).toBe("")
})

test("parseLoopInput rejects an interval that would overflow the timer", () => {
  // setTimeout keeps its delay in a signed 32-bit int, so anything past ~24.8 days fires at 1ms —
  // a monthly loop would silently become a tight spin.
  const tooLong = parseLoopInput("30d sweep the repo")
  expect(tooLong).toHaveProperty("error")
  expect("error" in tooLong ? tooLong.error : "").toContain("at most")

  expect(parseLoopInput("sweep the repo every 30 days")).toHaveProperty("error")

  // Just inside the bound still parses.
  expect(parseLoopInput("24d sweep the repo")).toMatchObject({ mode: "interval", intervalSeconds: 24 * 86_400 })
})
