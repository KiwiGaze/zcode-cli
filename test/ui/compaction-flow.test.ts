import { test, expect } from "bun:test"
import { AppController } from "@/ui/controller"
import { createSession } from "@/session/session"
import { mockLLM } from "../support/mock-llm"
import { testConfig, withApiKey } from "../support/config"
import { testRuntime } from "../support/runtime"
import { createRuntime } from "@/agent/runtime"

test("a turn that crosses the context threshold triggers compaction", async () => {
  const restore = withApiKey()
  try {
    const config = testConfig({
      compaction: { threshold: 0.8 },
      models: { "glm-5.2": { context: 30, maxOutput: 100 } },
    })
    const session = createSession("/tmp/zcode-test")
    const runtime = testRuntime(config)
    const llm = mockLLM([
      { text: "first reply", usage: { input: 10, output: 2 } },
      { text: "second reply", usage: { input: 28, output: 2 } },
      { text: "## Goal\nkeep building\n## Next steps\ncontinue" },
    ])
    const controller = new AppController({ session, config, runtime, deps: { llm: llm.fn } })

    await controller.submit("do the first thing")
    expect(runtime.compactions).toHaveLength(0)

    await controller.submit("do the second thing")
    expect(runtime.compactions).toHaveLength(1)
    expect(runtime.compactions[0]?.summary).toContain("keep building")

    const notices = controller.getSnapshot().history.filter((item) => item.kind === "notice")
    expect(notices.some((item) => item.kind === "notice" && item.text === "context compacted")).toBe(true)
  } finally {
    restore()
  }
})

test("todos updated by the todo tool appear in the snapshot", async () => {
  const restore = withApiKey()
  try {
    const config = testConfig()
    const session = createSession("/tmp/zcode-test")
    const runtime = createRuntime(config)
    const llm = mockLLM([
      {
        toolCalls: [
          {
            callId: "c1",
            name: "todowrite",
            input: { todos: [{ id: "t1", content: "write tests", status: "in_progress" }] },
          },
        ],
      },
      { text: "done" },
    ])
    const controller = new AppController({ session, config, runtime, deps: { llm: llm.fn } })
    await controller.submit("make a plan")
    const todos = controller.getSnapshot().todos
    expect(todos).toHaveLength(1)
    expect(todos[0]?.content).toBe("write tests")
  } finally {
    restore()
  }
})
