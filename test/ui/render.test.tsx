import { test, expect } from "bun:test"
import { z } from "zod"
import { render } from "ink-testing-library"
import { App } from "@/ui/App"
import { AppController } from "@/ui/controller"
import { createSession } from "@/session/session"
import { defineTool } from "@/tools/registry"
import { okResult } from "@/tools/types"
import { mockLLM } from "../support/mock-llm"
import { testConfig, withApiKey } from "../support/config"
import { testRuntime } from "../support/runtime"

function tick(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test("App renders a streamed assistant reply and status bar", async () => {
  const restore = withApiKey()
  try {
    const session = createSession("/tmp/zcode-test")
    const llm = mockLLM([{ reasoning: "reasoning-shown", text: "assistant-answer", usage: { input: 15, output: 4 } }])
    const controller = new AppController({
      session,
      config: testConfig(),
      runtime: testRuntime(testConfig()),
      deps: { llm: llm.fn },
    })
    const { lastFrame, unmount } = render(<App controller={controller} />)

    await controller.submit("question-here")
    await tick()

    const frame = lastFrame() ?? ""
    expect(frame).toContain("question-here")
    expect(frame).toContain("assistant-answer")
    expect(frame).toContain("reasoning-shown")
    expect(frame).toContain("zai · glm-5.2")
    unmount()
  } finally {
    restore()
  }
})

test("App shows the input prompt and command completions", async () => {
  const restore = withApiKey()
  try {
    const session = createSession("/tmp/zcode-test")
    const controller = new AppController({
      session,
      config: testConfig(),
      runtime: testRuntime(testConfig()),
      deps: { llm: mockLLM([]).fn },
    })
    const { lastFrame, stdin, unmount } = render(<App controller={controller} />)
    await tick()
    stdin.write("/mo")
    await tick()
    const frame = lastFrame() ?? ""
    expect(frame).toContain("/model")
    unmount()
  } finally {
    restore()
  }
})

test("App starts with the compact welcome line", () => {
  const config = testConfig()
  const controller = new AppController({
    session: createSession("/tmp/zcode-test"),
    config,
    runtime: testRuntime(config),
    deps: { llm: mockLLM([]).fn },
  })
  const { lastFrame, unmount } = render(<App controller={controller} />)

  expect(lastFrame()).toContain("zcode · glm-5.2 · 200k ctx · /help")
  unmount()
})

test("App keeps configured model text on one welcome line", () => {
  const config = testConfig({
    model: "custom\nmodel",
    models: { "custom\nmodel": { context: 64_000, maxOutput: 4_000 } },
  })
  const controller = new AppController({
    session: createSession("/tmp/zcode-test"),
    config,
    runtime: testRuntime(config),
    deps: { llm: mockLLM([]).fn },
  })
  const { lastFrame, unmount } = render(<App controller={controller} />)

  expect(lastFrame()).toContain("zcode · custom model · 64k ctx · /help")
  expect(lastFrame()).not.toContain("custom\nmodel")
  unmount()
})

test("App shows queued labels and lets abort restore them before drain", async () => {
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
    const llm = async function* () {
      markStarted()
      await released
      yield {
        type: "finish" as const,
        reason: "stop" as const,
        usage: { input: 1, output: 0, reasoning: 0, cachedInput: 0 },
      }
    }
    const config = testConfig()
    const controller = new AppController({
      session: createSession("/tmp/zcode-test"),
      config,
      runtime: testRuntime(config),
      deps: { llm },
    })
    const view = render(<App controller={controller} />)

    const turn = controller.submit("first")
    await started
    await controller.submit("second\nthird")
    await tick()

    expect(view.lastFrame()).toContain("Queued: second third")
    expect(view.lastFrame()).toContain("Alt+↑ to edit all queued messages")

    expect(controller.abortAndTakePendingDrafts()).toEqual(["second\nthird"])
    release()
    await turn
    view.unmount()
  } finally {
    restore()
  }
})

test("a pending tool owns activity feedback instead of the global indicator", async () => {
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
    const waitTool = defineTool({
      name: "wait",
      description: "waits for the test",
      inputSchema: z.object({}),
      permission: () => null,
      execute: async () => {
        markStarted()
        await released
        return okResult("done")
      },
    })
    const config = testConfig()
    const llm = mockLLM([{ toolCalls: [{ callId: "call-1", name: "wait", input: {} }] }, { text: "finished" }])
    const controller = new AppController({
      session: createSession("/tmp/zcode-test"),
      config,
      runtime: testRuntime(config, [waitTool]),
      deps: { llm: llm.fn },
    })
    const view = render(<App controller={controller} />)

    const turn = controller.submit("wait")
    await started
    await tick()
    const frame = view.lastFrame() ?? ""

    expect(frame).toContain("wait")
    expect(frame).not.toContain("Thinking")
    expect(frame).not.toContain("Waiting for model")

    release()
    await turn
    view.unmount()
  } finally {
    restore()
  }
})
