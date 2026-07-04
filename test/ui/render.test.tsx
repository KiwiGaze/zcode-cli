import { test, expect } from "bun:test"
import { render } from "ink-testing-library"
import { App } from "@/ui/App"
import { AppController } from "@/ui/controller"
import { createSession } from "@/session/session"
import { mockLLM } from "../support/mock-llm"
import { testConfig, withApiKey } from "../support/config"

function tick(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test("App renders a streamed assistant reply and status bar", async () => {
  const restore = withApiKey()
  try {
    const session = createSession("/tmp/zcode-test")
    const llm = mockLLM([{ reasoning: "reasoning-shown", text: "assistant-answer", usage: { input: 15, output: 4 } }])
    const controller = new AppController({ session, config: testConfig(), deps: { llm: llm.fn } })
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
    const controller = new AppController({ session, config: testConfig(), deps: { llm: mockLLM([]).fn } })
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
