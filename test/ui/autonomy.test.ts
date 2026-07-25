import { test, expect } from "bun:test"
import { AppController } from "@/ui/controller"
import { createSession } from "@/session/session"
import { GOAL_TRANSCRIPT_FRAMING } from "@/agent/autonomy"
import type { CompleteFn, CompleteRequest } from "@/llm/complete"
import type { ViewItem } from "@/ui/view"
import { mockLLM, type MockTurn } from "../support/mock-llm"
import { testConfig, withApiKey } from "../support/config"
import { testRuntime } from "../support/runtime"

interface FakeEvaluator {
  complete: CompleteFn
  calls: CompleteRequest[]
}

/** Replays scripted evaluator replies; the last reply repeats once the script runs out. */
function evaluator(replies: (string | Error)[]): FakeEvaluator {
  const calls: CompleteRequest[] = []
  let index = 0
  const complete: CompleteFn = async (request) => {
    calls.push(request)
    const reply = replies[Math.min(index, replies.length - 1)]
    index += 1
    if (reply instanceof Error) throw reply
    return reply ?? ""
  }
  return { complete, calls }
}

const instantSleep = async (): Promise<boolean> => false

function notices(history: ViewItem[]): string[] {
  return history.filter((item) => item.kind === "notice").map((item) => item.text)
}

function userLabels(history: ViewItem[]): string[] {
  return history.filter((item) => item.kind === "user").map((item) => item.text)
}

function build(turns: MockTurn[], fake: FakeEvaluator, over: Parameters<typeof testConfig>[0] = {}) {
  const config = testConfig(over)
  const session = createSession("/tmp/zcode-test")
  const runtime = testRuntime(config, [])
  const llm = mockLLM(turns)
  const controller = new AppController({
    session,
    config,
    runtime,
    deps: { llm: llm.fn },
    autonomy: { complete: fake.complete, sleep: instantSleep },
  })
  return { config, session, runtime, llm, controller }
}

test("/goal runs the directive turn, evaluates with the role-separated wire, and clears when met", async () => {
  const restore = withApiKey()
  try {
    const fake = evaluator(['{"ok":true,"reason":"the suite is green"}'])
    const { llm, controller } = build([{ text: "on it" }], fake)

    await controller.runGoal("the test suite passes")

    expect(llm.calls).toHaveLength(1)
    expect(fake.calls).toHaveLength(1)

    const request = fake.calls[0]!
    expect(request.messages?.map((message) => message.role)).toEqual(["user", "assistant", "user"])
    expect(request.messages?.[0]?.content).toBe(GOAL_TRANSCRIPT_FRAMING)
    expect(request.messages?.[1]?.content).toContain("on it")
    expect(request.messages?.[2]?.content).toContain("the test suite passes")
    // The condition rides only the final judge message, never the transcript message.
    expect(request.messages?.[1]?.content).not.toContain("the test suite passes")
    expect(request.temperature).toBe(0)
    expect(request.maxOutputTokens).toBe(512)
    expect(request.prompt).toBeUndefined()

    const history = controller.getSnapshot().history
    expect(userLabels(history)).toEqual(["/goal the test suite passes"])
    expect(notices(history).some((text) => text.includes("goal achieved"))).toBe(true)
    expect(controller.getSnapshot().status.autonomy).toBeUndefined()
  } finally {
    restore()
  }
})

test("a not-met verdict feeds its reason into the next turn", async () => {
  const restore = withApiKey()
  try {
    const fake = evaluator(['{"ok":false,"reason":"two tests still fail"}', '{"ok":true,"reason":"all green"}'])
    const { llm, controller } = build([{ text: "first attempt" }, { text: "second attempt" }], fake)

    await controller.runGoal("the test suite passes")

    expect(llm.calls).toHaveLength(2)
    expect(fake.calls).toHaveLength(2)

    const second = llm.calls[1]!.messages
    const lastUser = [...second].reverse().find((item) => item.type === "user")
    const text = lastUser?.type === "user" ? lastUser.content.map((part) => part.text).join("") : ""
    expect(text).toContain("was not met")
    expect(text).toContain("two tests still fail")

    // Retry turns stay out of the scrollback; only the first tick is labeled.
    expect(userLabels(controller.getSnapshot().history)).toEqual(["/goal the test suite passes"])
  } finally {
    restore()
  }
})

test("an unparseable verdict never clears the goal and the evaluation cap stops the pursuit", async () => {
  const restore = withApiKey()
  try {
    const fake = evaluator(["I think it is probably fine now?"])
    const { llm, controller } = build([{ text: "a" }, { text: "b" }, { text: "c" }], fake, {
      autonomy: { goalMaxEvaluations: 2, loopMaxTicks: 100 },
    })

    await controller.runGoal("ship it")

    expect(llm.calls).toHaveLength(2)
    expect(fake.calls).toHaveLength(2)
    expect(notices(controller.getSnapshot().history).some((text) => text.includes("after 2 evaluations"))).toBe(true)
    expect(notices(controller.getSnapshot().history).some((text) => text.includes("goal achieved"))).toBe(false)
    expect(controller.getSnapshot().status.autonomy).toBeUndefined()
  } finally {
    restore()
  }
})

test("an evaluator that throws is treated as not met", async () => {
  const restore = withApiKey()
  try {
    const fake = evaluator([new Error("transport exploded")])
    const { llm, controller } = build([{ text: "a" }, { text: "b" }, { text: "c" }], fake, {
      autonomy: { goalMaxEvaluations: 2, loopMaxTicks: 100 },
    })

    await controller.runGoal("ship it")

    expect(llm.calls).toHaveLength(2)
    expect(notices(controller.getSnapshot().history).some((text) => text.includes("goal achieved"))).toBe(false)
    expect(notices(controller.getSnapshot().history).some((text) => text.includes("after 2 evaluations"))).toBe(true)
  } finally {
    restore()
  }
})

test("a goal judged impossible stops immediately", async () => {
  const restore = withApiKey()
  try {
    const fake = evaluator(['{"ok":false,"impossible":true,"reason":"the target file does not exist"}'])
    const { llm, controller } = build([{ text: "looking" }, { text: "never" }], fake)

    await controller.runGoal("fix src/does-not-exist.ts")

    expect(llm.calls).toHaveLength(1)
    expect(notices(controller.getSnapshot().history).some((text) => text.includes("impossible"))).toBe(true)
  } finally {
    restore()
  }
})

test("interval mode ticks on the timer and stops at the tick cap without exposing schedulewakeup", async () => {
  const restore = withApiKey()
  try {
    const fake = evaluator([""])
    const { llm, controller } = build(
      Array.from({ length: 6 }, () => ({ text: "ping" })),
      fake,
      { autonomy: { goalMaxEvaluations: 25, loopMaxTicks: 3 } },
    )

    await controller.runLoop("1m ping")

    expect(llm.calls).toHaveLength(3)
    for (const call of llm.calls) {
      expect(call.tools.map((tool) => tool.name)).not.toContain("schedulewakeup")
    }
    expect(fake.calls).toHaveLength(0)
    expect(notices(controller.getSnapshot().history).some((text) => text.includes("after 3 ticks"))).toBe(true)
    expect(userLabels(controller.getSnapshot().history)).toEqual(["/loop 1m ping"])
  } finally {
    restore()
  }
})

test("dynamic mode self-paces through schedulewakeup, clamps the delay, and converges when unscheduled", async () => {
  const restore = withApiKey()
  try {
    const fake = evaluator([""])
    const { llm, controller, runtime } = build(
      [
        // Tick 1 needs two LLM calls: the tool call, then the reply after its result.
        {
          text: "checked once",
          toolCalls: [
            {
              callId: "w1",
              name: "schedulewakeup",
              input: { delaySeconds: 5, reason: "check again shortly", prompt: "check the deploy again" },
            },
          ],
        },
        { text: "scheduled, ending the turn" },
        // Tick 2 schedules nothing, so the loop converges.
        { text: "deploy is green, nothing more to do" },
        { text: "should never run" },
      ],
      fake,
    )

    await controller.runLoop("watch the deploy")

    expect(llm.calls).toHaveLength(3)
    // The tool is exposed only while the loop runs.
    expect(llm.calls[0]!.tools.map((tool) => tool.name)).toContain("schedulewakeup")

    // The requested 5s was clamped up to the 60s floor, visible in the tool result.
    const wakeupResult = controller.session_().items.find((item) => item.type === "tool-result" && item.callId === "w1")
    expect(wakeupResult?.type === "tool-result" ? wakeupResult.result.output : "").toContain("60s")

    // Tick 2 ran the prompt the model passed back, not the original.
    const secondPrompt = llm.calls[2]!.messages.filter((item) => item.type === "user").at(-1)
    const text = secondPrompt?.type === "user" ? secondPrompt.content.map((part) => part.text).join("") : ""
    expect(text).toContain("check the deploy again")

    expect(notices(controller.getSnapshot().history).some((note) => note.includes("converged"))).toBe(true)
    // Unregistered once the loop ends.
    expect(runtime.registry.has("schedulewakeup")).toBe(false)
  } finally {
    restore()
  }
})

test("a schedulewakeup call outside loop mode fails closed", async () => {
  const restore = withApiKey()
  try {
    const fake = evaluator([""])
    const { llm, controller, session } = build(
      [
        {
          toolCalls: [{ callId: "w1", name: "schedulewakeup", input: { delaySeconds: 300, reason: "r", prompt: "p" } }],
        },
        { text: "understood" },
      ],
      fake,
    )

    await controller.submit("just a normal turn")

    expect(llm.calls[0]!.tools.map((tool) => tool.name)).not.toContain("schedulewakeup")
    const result = session.items.find((item) => item.type === "tool-result" && item.callId === "w1")
    expect(result?.type === "tool-result" ? result.result.status : "").toBe("error")
    expect(result?.type === "tool-result" ? result.result.output : "").toContain("unknown tool")
  } finally {
    restore()
  }
})

test("the session cost backstop stops a pursuit between ticks", async () => {
  const restore = withApiKey()
  try {
    const fake = evaluator(['{"ok":false,"reason":"not yet"}'])
    // glm-5.2 input is $1.4/Mtok, so one turn of a million prompt tokens costs $1.40.
    const { llm, controller } = build(
      Array.from({ length: 5 }, () => ({ text: "working", usage: { input: 1_000_000, output: 0 } })),
      fake,
      { budget: { maxCostUsd: 1, warnAt: 0.8 }, autonomy: { goalMaxEvaluations: 25, loopMaxTicks: 100 } },
    )

    await controller.runGoal("keep going forever")

    // Stopped after one turn on cost, despite 24 evaluations of headroom left.
    expect(llm.calls).toHaveLength(1)
    expect(fake.calls).toHaveLength(1)
    expect(notices(controller.getSnapshot().history).some((text) => text.includes("cost limit reached"))).toBe(true)
  } finally {
    restore()
  }
})

test("abort during the inter-tick wait stops the loop with no further LLM calls", async () => {
  const restore = withApiKey()
  try {
    const fake = evaluator([""])
    const config = testConfig()
    const session = createSession("/tmp/zcode-test")
    const runtime = testRuntime(config, [])
    const llm = mockLLM(Array.from({ length: 5 }, () => ({ text: "ping" })))

    // A sleep that only resolves when the driver's stop signal fires.
    const pendingSleep = (_ms: number, signal: AbortSignal): Promise<boolean> =>
      new Promise((resolve) => {
        if (signal.aborted) resolve(true)
        else signal.addEventListener("abort", () => resolve(true), { once: true })
      })

    const controller = new AppController({
      session,
      config,
      runtime,
      deps: { llm: llm.fn },
      autonomy: { complete: fake.complete, sleep: pendingSleep },
    })

    const run = controller.runLoop("1m ping")
    await new Promise((resolve) => setTimeout(resolve, 20))
    controller.abort()
    await run

    expect(llm.calls).toHaveLength(1)
    expect(controller.getSnapshot().status.autonomy).toBeUndefined()
  } finally {
    restore()
  }
})

test("a malformed /loop input reports usage and starts nothing", async () => {
  const restore = withApiKey()
  try {
    const fake = evaluator([""])
    const { llm, controller } = build([{ text: "should not run" }], fake)

    await controller.runLoop("")
    await controller.runLoop("every 5 minutes")

    expect(llm.calls).toHaveLength(0)
    expect(notices(controller.getSnapshot().history).every((text) => text.startsWith("usage: /loop"))).toBe(true)
    expect(controller.getSnapshot().status.autonomy).toBeUndefined()
  } finally {
    restore()
  }
})

test("an empty /goal reports status instead of starting a pursuit", async () => {
  const restore = withApiKey()
  try {
    const fake = evaluator([""])
    const { llm, controller } = build([{ text: "should not run" }], fake)

    await controller.runGoal("   ")

    expect(llm.calls).toHaveLength(0)
    expect(notices(controller.getSnapshot().history)).toEqual(["no goal is active"])
  } finally {
    restore()
  }
})
