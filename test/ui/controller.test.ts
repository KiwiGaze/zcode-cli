import { test, expect } from "bun:test"
import { AppController } from "@/ui/controller"
import { createSession } from "@/session/session"
import { mockLLM } from "../support/mock-llm"
import { testConfig, withApiKey } from "../support/config"
import { testRuntime } from "../support/runtime"
import type { Skill } from "@/skills/types"

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
