import { test, expect } from "bun:test"
import { z } from "zod"
import { AppController } from "@/ui/controller"
import { createSession } from "@/session/session"
import { defineTool } from "@/tools/registry"
import { okResult } from "@/tools/types"
import type { ChatItem } from "@/session/messages"
import type { SessionStore } from "@/session/store"
import { mockLLM } from "../support/mock-llm"
import { testConfig, withApiKey } from "../support/config"
import { testRuntime } from "../support/runtime"
import type { Skill } from "@/skills/types"
import type { LLMStreamFn } from "@/llm/types"

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

test("controller streams a turn into history and updates usage", async () => {
  const restore = withApiKey()
  try {
    const session = createSession("/tmp/zcode-test")
    const llm = mockLLM([{ reasoning: "hmm", text: "done", usage: { input: 12, output: 3 } }])
    const controller = new AppController({
      session,
      config: testConfig(),
      runtime: testRuntime(testConfig()),
      deps: { llm: llm.fn },
    })
    await controller.submit("hello")

    const snapshot = controller.getSnapshot()
    expect(snapshot.activity.kind).toBe("idle")
    expect(snapshot.live).toBeNull()
    const kinds = snapshot.history.map((item) => item.kind)
    expect(kinds).toEqual(["user", "assistant"])
    expect(snapshot.status.usage.input).toBe(12)
  } finally {
    restore()
  }
})

test("controller switches model and records a notice", async () => {
  const restore = withApiKey()
  try {
    const session = createSession("/tmp/zcode-test")
    const controller = new AppController({
      session,
      config: testConfig(),
      runtime: testRuntime(testConfig()),
      deps: { llm: mockLLM([]).fn },
    })
    controller.setModel("bigmodel", "glm-4.7")
    const snapshot = controller.getSnapshot()
    expect(snapshot.status.provider).toBe("bigmodel")
    expect(snapshot.status.model).toBe("glm-4.7")
    expect(snapshot.history.at(-1)?.kind).toBe("notice")
  } finally {
    restore()
  }
})

test("inputs typed while busy are queued and run after the current turn", async () => {
  const restore = withApiKey()
  try {
    const session = createSession("/tmp/zcode-test")
    const llm = mockLLM([{ text: "one" }, { text: "two" }])
    const controller = new AppController({
      session,
      config: testConfig(),
      runtime: testRuntime(testConfig()),
      deps: { llm: llm.fn },
    })

    const first = controller.submit("a")
    await controller.submit("b")
    await first

    expect(llm.calls).toHaveLength(2)
    const userMessages = controller.getSnapshot().history.filter((item) => item.kind === "user")
    expect(userMessages).toHaveLength(2)
  } finally {
    restore()
  }
})

test("clearing or loading a session aborts the active turn before replacing its state", async () => {
  const restore = withApiKey()
  try {
    for (const action of ["clear", "load"] as const) {
      let release!: () => void
      const released = new Promise<void>((resolve) => {
        release = resolve
      })
      let markStarted!: () => void
      const started = new Promise<void>((resolve) => {
        markStarted = resolve
      })
      let turnSignal: AbortSignal | undefined
      const llm: LLMStreamFn = async function* (request) {
        turnSignal = request.signal
        markStarted()
        await released
        if (request.signal.aborted) return
        yield { type: "finish", reason: "stop", usage: { input: 1, output: 0, reasoning: 0, cachedInput: 0 } }
      }
      const session = createSession("/tmp/zcode-test")
      const config = testConfig()
      const controller = new AppController({ session, config, runtime: testRuntime(config), deps: { llm } })

      const turn = controller.submit("in flight")
      await started
      if (action === "clear") controller.clear()
      else {
        controller.loadFrom({
          session: createSession("/tmp/zcode-test"),
          compactions: [],
          hasMeasuredUsageAfterLatestCompaction: false,
        })
      }

      expect(turnSignal?.aborted).toBe(true)
      release()
      await turn
      expect(controller.session_().items).toEqual([])
    }
  } finally {
    restore()
  }
})

test("runSkill expands the body, runs it, and shows a compact command label", async () => {
  const restore = withApiKey()
  try {
    const session = createSession("/tmp/zcode-test")
    const runtime = testRuntime(testConfig())
    runtime.skills = [skill({ name: "greet", description: "d", body: "Greet $ARGUMENTS warmly" })]
    const llm = mockLLM([{ text: "hi" }])
    const controller = new AppController({ session, config: testConfig(), runtime, deps: { llm: llm.fn } })

    await controller.runSkill("greet", "Ada")

    const userMessage = llm.calls[0]?.messages.find((message) => (message as { type?: string }).type === "user")
    expect(JSON.stringify(userMessage)).toContain("Greet Ada warmly")
    const history = controller.getSnapshot().history
    expect(history.some((item) => item.kind === "user" && item.text === "/greet Ada")).toBe(true)
  } finally {
    restore()
  }
})

test("clearing the session drops the compression note with the rest of the context", async () => {
  const restore = withApiKey()
  try {
    const config = testConfig({
      models: { "glm-5.2": { context: 1000, maxOutput: 100 } },
      compaction: { threshold: 1 },
      // keep the big result in context so the compression tiers, not spill, handle it
      spill: { enabled: false, thresholdBytes: 30_720, previewLines: 200 },
    })
    const session = createSession("/tmp/zcode-test")
    const dumpTool = defineTool<{ q?: string }>({
      name: "dump",
      description: "returns a lot of text",
      inputSchema: z.object({ q: z.string().optional() }),
      permission: () => null,
      execute: async () => okResult("x".repeat(60_000)),
    })
    const llm = mockLLM([
      { text: "dumping", toolCalls: [{ callId: "c1", name: "dump", input: {} }], usage: { input: 900 } },
      { text: "done", usage: { input: 900 } },
    ])
    const controller = new AppController({
      session,
      config,
      runtime: testRuntime(config, [dumpTool]),
      deps: { llm: llm.fn },
    })

    await controller.submit("dump everything")
    expect(controller.getSnapshot().status.compressionNote).toBeDefined()

    controller.clear()
    expect(controller.getSnapshot().status.compressionNote).toBeUndefined()
  } finally {
    restore()
  }
})

test("clearing conversation state preserves spent cost and resets memory recall", () => {
  const config = testConfig()
  const session = createSession("/tmp/zcode-test")
  session.totalUsage = { input: 12, output: 3, reasoning: 0, cachedInput: 0 }
  session.usageByModel["glm-5.2"] = { ...session.totalUsage }
  let memoryResetCount = 0
  const memory = {
    beginTurn() {},
    pollInjection: () => null,
    promptSection: async () => "",
    setConfig() {},
    reset() {
      memoryResetCount += 1
    },
  }
  const controller = new AppController({
    session,
    config,
    runtime: testRuntime(config),
    memory,
    deps: { llm: mockLLM([]).fn },
  })

  controller.clear()

  expect(controller.session_().items).toEqual([])
  expect(controller.session_().totalUsage).toEqual({ input: 0, output: 0, reasoning: 0, cachedInput: 0 })
  expect(controller.session_().usageByModel).toEqual({
    "glm-5.2": { input: 12, output: 3, reasoning: 0, cachedInput: 0 },
  })
  expect(memoryResetCount).toBe(1)
})

test("a finished turn has every item on the store before submit resolves", async () => {
  const restore = withApiKey()
  try {
    const config = testConfig()
    const session = createSession("/tmp/zcode-test")
    const echo = defineTool<{ q?: string }>({
      name: "echo",
      description: "echoes",
      inputSchema: z.object({ q: z.string().optional() }),
      permission: () => null,
      execute: async () => okResult("echoed"),
    })
    // a store slow enough that a turn always advances while an append is in flight
    const appended: ChatItem[] = []
    const store = {
      appendItem: async (item: ChatItem) => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        appended.push(item)
      },
      appendCompaction: async () => {},
    } as unknown as SessionStore
    const llm = mockLLM([
      {
        text: "working",
        toolCalls: [
          { callId: "c1", name: "echo", input: {} },
          { callId: "c2", name: "echo", input: {} },
        ],
      },
      { text: "done" },
    ])
    const controller = new AppController({
      session,
      config,
      runtime: testRuntime(config, [echo]),
      store,
      deps: { llm: llm.fn },
    })

    await controller.submit("go")

    expect(appended).toEqual(session.items)
  } finally {
    restore()
  }
})

test("runSkill refuses a skill that is not user-invocable", async () => {
  const session = createSession("/tmp/zcode-test")
  const runtime = testRuntime(testConfig())
  runtime.skills = [skill({ name: "internal", description: "d", body: "x", userInvocable: false })]
  const llm = mockLLM([])
  const controller = new AppController({ session, config: testConfig(), runtime, deps: { llm: llm.fn } })

  await controller.runSkill("internal", "")

  expect(controller.getSnapshot().history.at(-1)?.kind).toBe("notice")
  expect(llm.calls).toHaveLength(0)
})

test("queued skills expose only their command label and execute the expanded prompt", async () => {
  const restore = withApiKey()
  try {
    let releaseFirst!: () => void
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let markStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const requests: string[] = []
    let callCount = 0
    const llm: LLMStreamFn = async function* (request) {
      callCount += 1
      requests.push(JSON.stringify(request.messages))
      if (callCount === 1) {
        markStarted()
        await firstReleased
      }
      yield { type: "finish", reason: "stop", usage: { input: 10, output: 1, reasoning: 0, cachedInput: 0 } }
    }
    const config = testConfig()
    const session = createSession("/tmp/zcode-test")
    const runtime = testRuntime(config)
    runtime.skills = [skill({ name: "greet", body: "Greet $ARGUMENTS warmly", allowedTools: ["bash(gh:*)"] })]
    const controller = new AppController({ session, config, runtime, deps: { llm } })

    const first = controller.submit("first")
    await firstStarted
    await controller.runSkill("greet", "Ada")

    const queuedSnapshot = controller.getSnapshot()
    expect(queuedSnapshot.queuedInputs).toEqual([{ label: "/greet Ada" }])
    expect(JSON.stringify(queuedSnapshot)).not.toContain("Greet Ada warmly")

    releaseFirst()
    await first

    expect(requests).toHaveLength(2)
    expect(requests[1]).toContain("Greet Ada warmly")
    expect(
      runtime.permissions.evaluate({
        tool: "bash",
        callId: "call-1",
        title: "gh pr list",
        key: "bash:gh pr list",
        subject: "gh pr list",
      }),
    ).toBe("allow")
    expect(
      controller
        .getSnapshot()
        .history.filter((item) => item.kind === "user")
        .map((item) => item.text),
    ).toEqual(["first", "/greet Ada"])
  } finally {
    restore()
  }
})

test("queued skill grants apply only when the queued skill starts", async () => {
  const restore = withApiKey()
  try {
    let release!: () => void
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const llm: LLMStreamFn = async function* () {
      markStarted()
      await released
      yield { type: "finish", reason: "stop", usage: { input: 1, output: 0, reasoning: 0, cachedInput: 0 } }
    }
    const config = testConfig()
    const runtime = testRuntime(config)
    runtime.skills = [skill({ name: "inspect", body: "Inspect safely", allowedTools: ["bash(gh:*)"] })]
    const controller = new AppController({
      session: createSession("/tmp/zcode-test"),
      config,
      runtime,
      deps: { llm },
    })
    const ghRequest = {
      tool: "bash",
      callId: "call-1",
      title: "gh pr list",
      key: "bash:gh pr list",
      subject: "gh pr list",
    }

    const turn = controller.submit("first")
    await started
    await controller.runSkill("inspect", "")

    expect(runtime.permissions.evaluate(ghRequest)).not.toBe("allow")
    expect(controller.takePendingDrafts()).toEqual(["/inspect"])
    expect(runtime.permissions.evaluate(ghRequest)).not.toBe("allow")

    release()
    await turn
  } finally {
    restore()
  }
})

test("taking queued drafts wins synchronously over turn-complete draining", async () => {
  const restore = withApiKey()
  try {
    let release!: () => void
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    let calls = 0
    const llm: LLMStreamFn = async function* () {
      calls += 1
      markStarted()
      await released
      yield { type: "finish", reason: "stop", usage: { input: 1, output: 0, reasoning: 0, cachedInput: 0 } }
    }
    const config = testConfig()
    const controller = new AppController({
      session: createSession("/tmp/zcode-test"),
      config,
      runtime: testRuntime(config),
      deps: { llm },
    })

    const turn = controller.submit("first")
    await started
    await controller.submit("  second  ")
    await controller.submit("third\nline")

    expect(controller.takePendingDrafts()).toEqual(["  second  ", "third\nline"])
    expect(controller.getSnapshot().queuedInputs).toEqual([])
    release()
    await turn

    expect(calls).toBe(1)
  } finally {
    restore()
  }
})

test("abort immediately hides activity, restores queued drafts, and records no successful completion", async () => {
  const restore = withApiKey()
  try {
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const llm: LLMStreamFn = async function* (request) {
      markStarted()
      await new Promise<void>((resolve) => request.signal.addEventListener("abort", () => resolve(), { once: true }))
    }
    const config = testConfig()
    const controller = new AppController({
      session: createSession("/tmp/zcode-test"),
      config,
      runtime: testRuntime(config),
      deps: { llm },
    })

    const turn = controller.submit("first")
    await started
    await controller.submit("second")
    expect(controller.getSnapshot().activity.kind).toBe("turn")

    expect(controller.abortAndTakePendingDrafts()).toEqual(["second"])
    expect(controller.getSnapshot().activity.kind).toBe("idle")
    await turn

    expect(controller.getSnapshot().completion).toMatchObject({ kind: "turn", outcome: "aborted" })
  } finally {
    restore()
  }
})

test("latest response usage drives measured context and cache projection", async () => {
  const restore = withApiKey()
  try {
    const config = testConfig({ models: { "glm-5.2": { context: 1_000, maxOutput: 100 } } })
    const controller = new AppController({
      session: createSession("/tmp/zcode-test"),
      config,
      runtime: testRuntime(config),
      deps: {
        llm: mockLLM([
          {
            text: "done",
            usage: { input: 100, output: 2, reasoning: 0, cachedInput: 73 },
          },
        ]).fn,
      },
    })

    await controller.submit("measure")
    const status = controller.getSnapshot().status

    expect(status.context).toEqual({ kind: "measured", tokens: 100, window: 1_000, compactAtRatio: 0.8 })
    expect(status.latestResponseUsage).toEqual({ input: 100, output: 2, reasoning: 0, cachedInput: 73 })
  } finally {
    restore()
  }
})
