import { test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { AppController } from "@/ui/controller"
import { createSession } from "@/session/session"
import { createRuntime } from "@/agent/runtime"
import { SessionStore, listSessions, loadSession } from "@/session/store"
import { mockLLM } from "../support/mock-llm"
import { testConfig, withApiKey } from "../support/config"

let dataDir: string
let prevXdg: string | undefined

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "zcode-resume-"))
  prevXdg = process.env["XDG_DATA_HOME"]
  process.env["XDG_DATA_HOME"] = dataDir
})
afterEach(async () => {
  if (prevXdg === undefined) delete process.env["XDG_DATA_HOME"]
  else process.env["XDG_DATA_HOME"] = prevXdg
  await rm(dataDir, { recursive: true, force: true })
})

test("a turn is persisted and a fresh controller resumes the history", async () => {
  const restore = withApiKey()
  try {
    const config = testConfig({ cwd: "/work/project" })

    // Controller A: run a turn against a real store.
    const sessionA = createSession("/work/project")
    const storeA = await SessionStore.open(sessionA)
    const controllerA = new AppController({
      session: sessionA,
      config,
      runtime: createRuntime(config),
      store: storeA,
      deps: { llm: mockLLM([{ text: "the first answer" }]).fn },
    })
    await controllerA.submit("remember this question")

    // The session file exists and lists the first user prompt.
    const summaries = await listSessions("/work/project")
    expect(summaries).toHaveLength(1)
    expect(summaries[0]?.preview).toBe("remember this question")

    // Controller B: fresh, resumes the saved session.
    const sessionB = createSession("/work/project")
    const controllerB = new AppController({
      session: sessionB,
      config,
      runtime: createRuntime(config),
      deps: { llm: mockLLM([]).fn },
    })
    const loaded = await loadSession("/work/project", sessionA.id)
    const storeB = await SessionStore.reopen("/work/project", sessionA.id)
    controllerB.loadFrom(loaded, storeB)

    const history = controllerB.getSnapshot().history
    const userItem = history.find((item) => item.kind === "user")
    const assistantItem = history.find((item) => item.kind === "assistant")
    expect(userItem?.kind === "user" ? userItem.text : "").toBe("remember this question")
    expect(assistantItem).toBeDefined()
  } finally {
    restore()
  }
})
