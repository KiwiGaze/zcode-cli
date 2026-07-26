import { test, expect } from "bun:test"
import { createScheduleWakeupTool, type WakeupRequest } from "@/tools/schedule-wakeup"
import { FileState } from "@/tools/file-state"
import type { ToolContext } from "@/tools/registry"
import { createSession } from "@/session/session"

function context(): ToolContext {
  return {
    cwd: "/tmp/zcode-test",
    signal: new AbortController().signal,
    callId: "c1",
    sessionId: "s1",
    usageSession: createSession("/tmp/zcode-test"),
    files: new FileState(),
    onProgress: () => {},
  }
}

test("schedulewakeup clamps, reports once, and never asks permission", async () => {
  const scheduled: WakeupRequest[] = []
  const tool = createScheduleWakeupTool((request) => scheduled.push(request))

  const parsed = tool.parse({ delaySeconds: 5, reason: "poll soon", prompt: "check CI" })
  expect(parsed.ok).toBe(true)
  if (!parsed.ok) throw new Error(parsed.error)
  const result = await tool.execute(parsed.value, context())

  expect(scheduled).toEqual([{ delaySeconds: 60, reason: "poll soon", prompt: "check CI" }])
  expect(result.status).toBe("ok")
  expect(result.output).toContain("60s")
  expect(result.title).toContain("60s")

  // Its only effect is the callback, so it is auto-approved.
  expect(tool.permission(parsed.value, context())).toBeNull()
})

test("schedulewakeup rejects a malformed call before executing", () => {
  const scheduled: WakeupRequest[] = []
  const tool = createScheduleWakeupTool((request) => scheduled.push(request))

  for (const raw of [
    {},
    { delaySeconds: 300 },
    { reason: "x", prompt: "y" },
    { delaySeconds: "soon", reason: "x", prompt: "y" },
  ]) {
    const parsed = tool.parse(raw)
    expect(parsed.ok).toBe(false)
  }
  expect(scheduled).toEqual([])
})

test("schedulewakeup clamps an over-long delay down to the ceiling", async () => {
  const scheduled: WakeupRequest[] = []
  const tool = createScheduleWakeupTool((request) => scheduled.push(request))

  const parsed = tool.parse({ delaySeconds: 86_400, reason: "tomorrow", prompt: "daily sweep" })
  if (!parsed.ok) throw new Error(parsed.error)
  await tool.execute(parsed.value, context())

  expect(scheduled[0]?.delaySeconds).toBe(3600)
})
