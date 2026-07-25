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
    const controller = new AppController({ session, config: testConfig(), runtime: testRuntime(testConfig()), deps: { llm: llm.fn } })
    await controller.submit("hello")

    const snapshot = controller.getSnapshot()
    expect(snapshot.busy).toBe(false)
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
    const controller = new AppController({ session, config: testConfig(), runtime: testRuntime(testConfig()), deps: { llm: mockLLM([]).fn } })
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
    const controller = new AppController({ session, config: testConfig(), runtime: testRuntime(testConfig()), deps: { llm: llm.fn } })

    const first = controller.submit("a")
    session.pendingInputs.push("b")
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
      else controller.loadFrom({ session: createSession("/tmp/zcode-test"), compactions: [] })

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
