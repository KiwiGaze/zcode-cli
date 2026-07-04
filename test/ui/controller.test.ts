import { test, expect } from "bun:test"
import { AppController } from "@/ui/controller"
import { createSession } from "@/session/session"
import { mockLLM } from "../support/mock-llm"
import { testConfig, withApiKey } from "../support/config"

test("controller streams a turn into history and updates usage", async () => {
  const restore = withApiKey()
  try {
    const session = createSession("/tmp/zcode-test")
    const llm = mockLLM([{ reasoning: "hmm", text: "done", usage: { input: 12, output: 3 } }])
    const controller = new AppController({ session, config: testConfig(), deps: { llm: llm.fn } })
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
    const controller = new AppController({ session, config: testConfig(), deps: { llm: mockLLM([]).fn } })
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
    const controller = new AppController({ session, config: testConfig(), deps: { llm: llm.fn } })

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
