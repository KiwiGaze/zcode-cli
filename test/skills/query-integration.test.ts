import { test, expect, afterEach } from "bun:test"
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { query } from "@/agent/query"
import { createRuntime } from "@/agent/runtime"
import { discoverSkills } from "@/skills/discover"
import { createSession } from "@/session/session"
import type { AgentEvent } from "@/agent/events"
import { ConfigSchema, type ResolvedConfig } from "@/config/config"
import { mockLLM } from "../support/mock-llm"
import { withApiKey } from "../support/config"

let project: string

afterEach(async () => {
  if (project !== undefined) await rm(project, { recursive: true, force: true })
})

function config(): ResolvedConfig {
  return { ...ConfigSchema.parse({ skills: { bundled: false } }), cwd: project }
}

async function collect(gen: AsyncGenerator<AgentEvent, void>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of gen) events.push(event)
  return events
}

test("a discovered skill enters the catalog and loads its body through the skill tool", async () => {
  const restore = withApiKey()
  try {
    project = await mkdtemp(path.join(tmpdir(), "zcode-skill-e2e-"))
    await mkdir(path.join(project, ".zcode/skills/demo"), { recursive: true })
    await writeFile(
      path.join(project, ".zcode/skills/demo/SKILL.md"),
      "---\ndescription: Demo skill\nwhen_to_use: testing\n---\nDEMO BODY CONTENT",
    )

    const cfg = config()
    const runtime = createRuntime(cfg)
    runtime.skills = (await discoverSkills(project, cfg)).skills
    const session = createSession(project)
    const llm = mockLLM([
      { toolCalls: [{ callId: "c1", name: "skill", input: { name: "demo" } }] },
      { text: "used the demo skill" },
    ])
    runtime.llm = llm.fn

    const events = await collect(
      query({
        prompt: "run demo",
        session,
        config: cfg,
        runtime,
        signal: new AbortController().signal,
        deps: { llm: llm.fn },
      }),
    )

    expect(llm.calls[0]?.system).toContain("# Available skills")
    expect(llm.calls[0]?.system).toContain("- demo: Demo skill")
    const toolEnd = events.find(
      (event): event is Extract<AgentEvent, { type: "tool-end" }> => event.type === "tool-end",
    )
    expect(toolEnd?.result.status).toBe("ok")
    expect(toolEnd?.result.output).toContain("DEMO BODY CONTENT")
    expect(session.invokedSkills.some((skill) => skill.name === "demo")).toBe(true)
  } finally {
    restore()
  }
})
