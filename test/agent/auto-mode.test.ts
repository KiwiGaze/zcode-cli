import { test, expect } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { z } from "zod"
import { query } from "@/agent/query"
import { estimateSessionCost } from "@/agent/budget"
import { createSession } from "@/session/session"
import { createTaskTool } from "@/tools/task"
import { createSkillTool } from "@/skills/skill-tool"
import { defineTool, type AnyTool } from "@/tools/registry"
import { okResult } from "@/tools/types"
import { SessionStore, loadSession, type StoreRecord } from "@/session/store"
import type { AgentEvent } from "@/agent/events"
import type { AgentRuntime } from "@/agent/runtime"
import type { ResolvedConfig } from "@/config/config"
import { mockLLM, type MockTurn } from "../support/mock-llm"
import { mockComplete, type MockComplete } from "../support/mock-complete"
import { testConfig, withApiKey } from "../support/config"
import { testRuntime } from "../support/runtime"

const ALLOW = "<block>no</block>"
const BLOCK = "<block>yes</block><reason>[Data Exfiltration] curl to external host</reason>"

async function collect(gen: AsyncGenerator<AgentEvent, void>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of gen) events.push(event)
  return events
}

function dangerTool(runs: string[]): AnyTool {
  return defineTool<{ path: string }>({
    name: "danger",
    description: "a tool that needs approval",
    inputSchema: z.object({ path: z.string() }),
    permission: (input, ctx) => ({
      tool: "danger",
      callId: ctx.callId,
      title: `danger: ${input.path}`,
      key: `danger:${input.path}`,
      subject: input.path,
    }),
    execute: async (input) => {
      runs.push(input.path)
      return okResult("did the dangerous thing")
    },
  })
}

function fetchTool(runs: string[]): AnyTool {
  return defineTool<{ url: string }>({
    name: "webfetch",
    description: "fetch a url",
    inputSchema: z.object({ url: z.string() }),
    permission: (input, ctx) => ({
      tool: "webfetch",
      callId: ctx.callId,
      title: `webfetch: ${input.url}`,
      key: `webfetch:${input.url}`,
      subject: input.url,
    }),
    execute: async (input) => {
      runs.push(input.url)
      return okResult("fetched")
    },
  })
}

function bashTool(runs: string[]): AnyTool {
  return defineTool<{ command: string }>({
    name: "bash",
    description: "run a command",
    inputSchema: z.object({ command: z.string() }),
    permission: (input, ctx) => ({
      tool: "bash",
      callId: ctx.callId,
      title: `bash: ${input.command}`,
      key: `bash:${input.command}`,
      subject: input.command,
    }),
    execute: async (input) => {
      runs.push(input.command)
      return okResult("ran")
    },
  })
}

interface Harness {
  config: ResolvedConfig
  runtime: AgentRuntime
  session: ReturnType<typeof createSession>
  llm: ReturnType<typeof mockLLM>
  fake: MockComplete
  run: () => Promise<AgentEvent[]>
}

function harness(
  turns: MockTurn[],
  replies: (string | Error)[],
  tools: AnyTool[],
  over: Parameters<typeof testConfig>[0] = {},
  autoMode = true,
): Harness {
  const config = testConfig(over)
  const session = createSession("/tmp/zcode-test")
  const runtime = testRuntime(config, tools)
  runtime.permissions.setAutoMode(autoMode)
  const llm = mockLLM(turns)
  const fake = mockComplete(replies)
  runtime.complete = fake.fn
  return {
    config,
    runtime,
    session,
    llm,
    fake,
    run: () =>
      collect(
        query({
          prompt: "go",
          session,
          config,
          runtime,
          signal: new AbortController().signal,
          deps: { llm: llm.fn },
        }),
      ),
  }
}

function toolEnds(events: AgentEvent[]): Extract<AgentEvent, { type: "tool-end" }>[] {
  return events.filter((event): event is Extract<AgentEvent, { type: "tool-end" }> => event.type === "tool-end")
}

test("the static deny floor overrides a permissive classifier", async () => {
  const restore = withApiKey()
  try {
    const runs: string[] = []
    // The classifier would allow, but a configured deny never reaches it.
    const h = harness(
      [{ toolCalls: [{ callId: "c1", name: "danger", input: { path: "/etc" } }] }, { text: "ok" }],
      [ALLOW],
      [dangerTool(runs)],
      { permissions: { danger: "deny" } },
    )

    const events = await h.run()

    expect(runs).toEqual([])
    expect(h.fake.calls).toHaveLength(0)
    expect(events.some((event) => event.type === "permission-ask")).toBe(false)
    expect(events.some((event) => event.type === "auto-verdict")).toBe(false)
    expect(toolEnds(events)[0]?.result.status).toBe("denied")
  } finally {
    restore()
  }
})

test("plan mode denies a mutating tool without consulting the classifier", async () => {
  const restore = withApiKey()
  try {
    const runs: string[] = []
    const h = harness(
      [{ toolCalls: [{ callId: "c1", name: "bash", input: { command: "rm -rf /" } }] }, { text: "ok" }],
      [ALLOW],
      [bashTool(runs)],
    )
    h.runtime.permissions.setPlanMode(true)

    const events = await h.run()

    expect(runs).toEqual([])
    expect(h.fake.calls).toHaveLength(0)
    expect(toolEnds(events)[0]?.result.status).toBe("denied")
  } finally {
    restore()
  }
})

test("configured allow rules skip the classifier", async () => {
  const restore = withApiKey()
  try {
    const runs: string[] = []
    const h = harness(
      [{ toolCalls: [{ callId: "c1", name: "bash", input: { command: "git status" } }] }, { text: "ok" }],
      [BLOCK],
      [bashTool(runs)],
      { bashRules: { "git status": "allow" } },
    )

    const events = await h.run()

    expect(runs).toEqual(["git status"])
    expect(h.fake.calls).toHaveLength(0)
    expect(toolEnds(events)[0]?.result.status).toBe("ok")
  } finally {
    restore()
  }
})

test("a classifier allow executes without any dialog", async () => {
  const restore = withApiKey()
  try {
    const runs: string[] = []
    const h = harness(
      [
        { toolCalls: [{ callId: "c1", name: "danger", input: { path: "/tmp/x" } }] },
        { text: "ok" },
      ],
      [ALLOW],
      [dangerTool(runs)],
      { permissions: { danger: "ask" } },
    )

    const events = await h.run()

    expect(runs).toEqual(["/tmp/x"])
    expect(events.some((event) => event.type === "permission-ask")).toBe(false)
    const verdict = events.find((event) => event.type === "auto-verdict")
    expect(verdict).toMatchObject({ verdict: "allow", tool: "danger", callId: "c1" })
    expect(toolEnds(events)[0]?.result.status).toBe("ok")
  } finally {
    restore()
  }
})

test("classifier side calls contribute to session usage", async () => {
  const restore = withApiKey()
  try {
    const runs: string[] = []
    const h = harness(
      [
        {
          toolCalls: [{ callId: "c1", name: "danger", input: { path: "/tmp/x" } }],
          usage: { input: 0, output: 0 },
        },
        { text: "ok", usage: { input: 0, output: 0 } },
      ],
      [ALLOW],
      [dangerTool(runs)],
      { permissions: { danger: "ask" } },
    )
    const side = mockComplete([ALLOW], { input: 7, output: 3, reasoning: 0, cachedInput: 2 })
    h.runtime.complete = side.fn

    await h.run()

    expect(h.session.totalUsage).toEqual({ input: 7, output: 3, reasoning: 0, cachedInput: 2 })
  } finally {
    restore()
  }
})

test("classifier stages retain their model identity for cost accounting", async () => {
  const restore = withApiKey()
  try {
    const h = harness(
      [{ toolCalls: [{ callId: "c1", name: "danger", input: { path: "/tmp/x" } }] }, { text: "ok" }],
      [BLOCK, ALLOW],
      [dangerTool([])],
      {
        model: "main",
        models: {
          main: { context: 100_000, maxOutput: 10_000, pricing: { input: 1, cachedInput: 0.5, output: 2 } },
          gate: { context: 100_000, maxOutput: 10_000, pricing: { input: 4, cachedInput: 1, output: 8 } },
          judge: { context: 100_000, maxOutput: 10_000, pricing: { input: 6, cachedInput: 2, output: 10 } },
        },
        autoMode: {
          enabled: true,
          gateModel: "gate",
          judgeModel: "judge",
          maxConsecutiveDenials: 3,
          maxTotalDenials: 20,
        },
      },
    )
    h.runtime.complete = mockComplete(
      [BLOCK, ALLOW],
      { input: 1_000_000, output: 0, reasoning: 0, cachedInput: 0 },
    ).fn

    await h.run()

    expect(h.session.usageByModel["gate"]?.input).toBe(1_000_000)
    expect(h.session.usageByModel["judge"]?.input).toBe(1_000_000)
    expect(estimateSessionCost(h.config, h.session.usageByModel)).toBeCloseTo(10, 3)
  } finally {
    restore()
  }
})

test("a classifier block denies with the rule reason and the loop continues", async () => {
  const restore = withApiKey()
  try {
    const runs: string[] = []
    const h = harness(
      [
        { toolCalls: [{ callId: "c1", name: "danger", input: { path: "/tmp/x" } }] },
        { text: "understood, trying something else" },
      ],
      [BLOCK, BLOCK],
      [dangerTool(runs)],
      { permissions: { danger: "ask" } },
    )

    const events = await h.run()

    expect(runs).toEqual([])
    const end = toolEnds(events)[0]
    expect(end?.result.status).toBe("denied")
    expect(end?.result.output).toContain("[Data Exfiltration]")
    // The loop stayed alive: the model got another turn.
    expect(h.llm.calls).toHaveLength(2)
    expect(events.some((event) => event.type === "done")).toBe(true)
  } finally {
    restore()
  }
})

test("hands back to the human after N consecutive blocks", async () => {
  const restore = withApiKey()
  try {
    const runs: string[] = []
    const h = harness(
      [
        { toolCalls: [{ callId: "c1", name: "danger", input: { path: "/a" } }] },
        { toolCalls: [{ callId: "c2", name: "danger", input: { path: "/b" } }] },
        { toolCalls: [{ callId: "c3", name: "danger", input: { path: "/c" } }] },
        { toolCalls: [{ callId: "c4", name: "danger", input: { path: "/d" } }] },
        { text: "done" },
      ],
      [BLOCK, BLOCK],
      [dangerTool(runs)],
      { permissions: { danger: "ask" }, autoMode: { enabled: true, maxConsecutiveDenials: 3, maxTotalDenials: 20 } },
    )

    const events: AgentEvent[] = []
    for await (const event of query({
      prompt: "go",
      session: h.session,
      config: h.config,
      runtime: h.runtime,
      signal: new AbortController().signal,
      deps: { llm: h.llm.fn },
    })) {
      // The human refuses too, so nothing dangerous runs.
      if (event.type === "permission-ask") event.respond("deny")
      events.push(event)
    }

    // Turns 1-3 are silently denied; the 4th trips the limit and reaches a real dialog.
    const asks = events.filter((event) => event.type === "permission-ask")
    expect(asks).toHaveLength(1)
    const handoff = events.findIndex((event) => event.type === "auto-handoff")
    const askAt = events.findIndex((event) => event.type === "permission-ask")
    expect(handoff).toBeGreaterThanOrEqual(0)
    expect(askAt).toBeGreaterThan(handoff)
    expect(runs).toEqual([])
  } finally {
    restore()
  }
})

test("a human allow resets the consecutive counter", async () => {
  const restore = withApiKey()
  try {
    const runs: string[] = []
    const h = harness(
      [
        { toolCalls: [{ callId: "c1", name: "danger", input: { path: "/a" } }] },
        { toolCalls: [{ callId: "c2", name: "danger", input: { path: "/b" } }] },
        { toolCalls: [{ callId: "c3", name: "danger", input: { path: "/c" } }] },
        { toolCalls: [{ callId: "c4", name: "danger", input: { path: "/d" } }] },
        { toolCalls: [{ callId: "c5", name: "danger", input: { path: "/e" } }] },
        { text: "done" },
      ],
      [BLOCK, BLOCK],
      [dangerTool(runs)],
      { permissions: { danger: "ask" }, autoMode: { enabled: true, maxConsecutiveDenials: 3, maxTotalDenials: 20 } },
    )

    const events: AgentEvent[] = []
    for await (const event of query({
      prompt: "go",
      session: h.session,
      config: h.config,
      runtime: h.runtime,
      signal: new AbortController().signal,
      deps: { llm: h.llm.fn },
    })) {
      if (event.type === "permission-ask") event.respond("allow-once")
      events.push(event)
    }

    // The human approved call 4; call 5 goes back to the classifier rather than the dialog.
    expect(events.filter((event) => event.type === "permission-ask")).toHaveLength(1)
    expect(runs).toEqual(["/d"])
    const verdicts = events.filter((event) => event.type === "auto-verdict")
    expect(verdicts).toHaveLength(4)
  } finally {
    restore()
  }
})

test("an unavailable classifier falls back to the dialog without burning denial budget", async () => {
  const restore = withApiKey()
  try {
    const runs: string[] = []
    const h = harness(
      [
        { toolCalls: [{ callId: "c1", name: "danger", input: { path: "/a" } }] },
        { toolCalls: [{ callId: "c2", name: "danger", input: { path: "/b" } }] },
        { toolCalls: [{ callId: "c3", name: "danger", input: { path: "/c" } }] },
        { text: "done" },
      ],
      [new Error("connection refused")],
      [dangerTool(runs)],
      { permissions: { danger: "ask" }, autoMode: { enabled: true, maxConsecutiveDenials: 3, maxTotalDenials: 20 } },
    )

    const events: AgentEvent[] = []
    for await (const event of query({
      prompt: "go",
      session: h.session,
      config: h.config,
      runtime: h.runtime,
      signal: new AbortController().signal,
      deps: { llm: h.llm.fn },
    })) {
      if (event.type === "permission-ask") event.respond("deny")
      events.push(event)
    }

    // Every action reached a human; none were auto-denied, so no hand-off ever fired.
    expect(events.filter((event) => event.type === "permission-ask")).toHaveLength(3)
    expect(events.some((event) => event.type === "auto-handoff")).toBe(false)
    // Pin the count first: `.every` on an empty array passes even if verdicts stop being emitted.
    const verdicts = events.filter((event) => event.type === "auto-verdict")
    expect(verdicts).toHaveLength(3)
    expect(verdicts.every((event) => event.verdict === "unavailable")).toBe(true)
    // The security core: nothing ran without an explicit human allow.
    expect(runs).toEqual([])
  } finally {
    restore()
  }
})

test("aborting the classifier does not open a manual approval dialog", async () => {
  const restore = withApiKey()
  try {
    const runs: string[] = []
    const h = harness(
      [
        {
          toolCalls: [
            { callId: "missing", name: "missing", input: {} },
            { callId: "c1", name: "danger", input: { path: "/tmp/x" } },
          ],
        },
      ],
      [],
      [dangerTool(runs)],
      { permissions: { danger: "ask" } },
    )
    const control = new AbortController()
    h.runtime.complete = async () => {
      control.abort()
      throw new Error("aborted")
    }

    const events: AgentEvent[] = []
    for await (const event of query({
      prompt: "go",
      session: h.session,
      config: h.config,
      runtime: h.runtime,
      signal: control.signal,
      deps: { llm: h.llm.fn },
    })) {
      events.push(event)
      if (event.type === "permission-ask") event.respond("deny")
    }

    expect(runs).toEqual([])
    expect(events.some((event) => event.type === "permission-ask")).toBe(false)
    expect(events.some((event) => event.type === "auto-verdict")).toBe(false)
    expect(events.filter((event) => event.type === "tool-start").map((event) => event.callId)).toEqual([
      "missing",
      "c1",
    ])
    expect(toolEnds(events).map((event) => [event.callId, event.result.status])).toEqual([
      ["missing", "error"],
      ["c1", "aborted"],
    ])
    const results = h.session.items.filter((item) => item.type === "tool-result")
    expect(results.map((item) => [item.callId, item.result.status])).toEqual([
      ["missing", "error"],
      ["c1", "aborted"],
    ])
  } finally {
    restore()
  }
})

test("aborting while consuming an auto verdict prevents execution and manual approval", async () => {
  const restore = withApiKey()
  try {
    for (const reply of [ALLOW, new Error("unavailable")]) {
      const runs: string[] = []
      const h = harness(
        [{ toolCalls: [{ callId: "c1", name: "danger", input: { path: "/tmp/x" } }] }],
        [reply],
        [dangerTool(runs)],
        { permissions: { danger: "ask" } },
      )
      const control = new AbortController()
      const events: AgentEvent[] = []

      for await (const event of query({
        prompt: "go",
        session: h.session,
        config: h.config,
        runtime: h.runtime,
        signal: control.signal,
        deps: { llm: h.llm.fn },
      })) {
        events.push(event)
        if (event.type === "auto-verdict") control.abort()
        if (event.type === "permission-ask") event.respond("deny")
      }

      expect(runs).toEqual([])
      expect(events.some((event) => event.type === "permission-ask")).toBe(false)
      expect(toolEnds(events).map((event) => [event.callId, event.result.status])).toEqual([["c1", "aborted"]])
    }
  } finally {
    restore()
  }
})

test("a subagent cannot launder a blocked action", async () => {
  const restore = withApiKey()
  try {
    const runs: string[] = []
    const config = testConfig({
      permissions: { danger: "ask" },
      autoMode: { enabled: true, maxConsecutiveDenials: 2, maxTotalDenials: 20 },
    })
    const session = createSession("/tmp/zcode-test")
    const runtime = testRuntime(config, [dangerTool(runs)])
    runtime.permissions.setAutoMode(true)
    // A wider child toolset than today's read-only default, as a granting definition would give it.
    runtime.agents = [
      {
        name: "helper",
        description: "a child granted a mutating tool",
        allowedTools: ["danger"],
        prompt: "You are a helper.",
        source: "disk",
      },
    ]

    const llm = mockLLM([
      // Parent delegates, then the child tries the same action three times.
      {
        toolCalls: [{ callId: "t1", name: "task", input: { description: "d", prompt: "p", subagent_type: "helper" } }],
      },
      { toolCalls: [{ callId: "k1", name: "danger", input: { path: "/etc/shadow" } }] },
      { toolCalls: [{ callId: "k2", name: "danger", input: { path: "/etc/shadow" } }] },
      { toolCalls: [{ callId: "k3", name: "danger", input: { path: "/etc/shadow" } }] },
      { text: "child gave up" },
      { text: "parent done" },
    ])
    runtime.llm = llm.fn
    // The task delegation itself is allowed; every action inside the child is blocked.
    const fake = mockComplete([ALLOW, BLOCK])
    runtime.complete = fake.fn
    runtime.registry.register(createTaskTool(runtime))

    const events = await collect(
      query({ prompt: "go", session, config, runtime, signal: new AbortController().signal, deps: { llm: llm.fn } }),
    )

    // Never executed: blocked while budget remained, then denied headlessly once it ran out.
    expect(runs).toEqual([])
    // The child is headless, so the hand-back cannot become an approval there.
    expect(events.some((event) => event.type === "permission-ask")).toBe(false)
    // The child's blocks were charged to the parent's own engine — delegation cannot reset them.
    expect(runtime.permissions.isAutoDenialLimitReached()).toBe(true)
    // The parent's task call was classified too, so delegation is itself a reviewed boundary.
    expect(fake.calls.length).toBeGreaterThanOrEqual(2)
  } finally {
    restore()
  }
})

test("webfetch routes to the classifier in auto mode unless the user allowed it", async () => {
  const restore = withApiKey()
  try {
    const runs: string[] = []
    const classified = harness(
      [{ toolCalls: [{ callId: "c1", name: "webfetch", input: { url: "https://example.invalid" } }] }, { text: "ok" }],
      [ALLOW],
      [fetchTool(runs)],
    )
    const events = await classified.run()

    expect(classified.fake.calls).toHaveLength(1)
    expect(runs).toEqual(["https://example.invalid"])
    expect(events.some((event) => event.type === "permission-ask")).toBe(false)

    // An explicit user allow is intent, and still wins over the auto-mode upgrade.
    const configured = harness(
      [{ toolCalls: [{ callId: "c1", name: "webfetch", input: { url: "https://example.invalid" } }] }, { text: "ok" }],
      [BLOCK],
      [fetchTool([])],
      { permissions: { webfetch: "allow" } },
    )
    await configured.run()
    expect(configured.fake.calls).toHaveLength(0)
  } finally {
    restore()
  }
})

test("the classifier sees the tools granted by an elevating inline skill", async () => {
  const restore = withApiKey()
  try {
    const h = harness(
      [{ toolCalls: [{ callId: "s1", name: "skill", input: { name: "deploy" } }] }, { text: "ok" }],
      [ALLOW],
      [],
    )
    h.runtime.skills = [
      {
        name: "deploy",
        description: "deploy infrastructure",
        allowedTools: ["bash(kubectl:*)"],
        context: "inline",
        userInvocable: true,
        disableModelInvocation: false,
        source: "bundled",
        dir: "",
        location: "<bundled>",
        body: "Deploy the service.",
      },
    ]
    h.runtime.registry.register(createSkillTool(h.runtime))

    await h.run()

    expect(h.fake.calls).toHaveLength(1)
    expect(h.fake.calls[0]?.prompt).toContain("bash(kubectl:*)")
  } finally {
    restore()
  }
})

test("auto mode off leaves the dialog path untouched", async () => {
  const restore = withApiKey()
  try {
    const runs: string[] = []
    const h = harness(
      [{ toolCalls: [{ callId: "c1", name: "danger", input: { path: "/tmp/x" } }] }, { text: "ok" }],
      [ALLOW],
      [dangerTool(runs)],
      { permissions: { danger: "ask" } },
      false,
    )

    const events: AgentEvent[] = []
    for await (const event of query({
      prompt: "go",
      session: h.session,
      config: h.config,
      runtime: h.runtime,
      signal: new AbortController().signal,
      deps: { llm: h.llm.fn },
    })) {
      if (event.type === "permission-ask") event.respond("allow-once")
      events.push(event)
    }

    expect(h.fake.calls).toHaveLength(0)
    expect(events.filter((event) => event.type === "permission-ask")).toHaveLength(1)
    expect(runs).toEqual(["/tmp/x"])
  } finally {
    restore()
  }
})

test("verdict records persist and never reload into history", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "zcode-auto-audit-"))
  const prevXdg = process.env["XDG_DATA_HOME"]
  process.env["XDG_DATA_HOME"] = dataDir
  const restore = withApiKey()
  try {
    const session = createSession("/tmp/zcode-test")
    const store = await SessionStore.open(session)

    await store.appendItem({ type: "user", id: "u1", ts: 1, content: [{ type: "text", text: "hello" }] })
    await store.appendAutoVerdict({
      type: "auto-verdict",
      ts: 2,
      callId: "c1",
      tool: "bash",
      subject: "rm -rf /",
      stage: 2,
      verdict: "block",
      reason: "[Irreversible Local Destruction] rm -rf",
      model: "glm-5.2",
    })
    await store.appendAutoVerdict({
      type: "auto-verdict",
      ts: 3,
      callId: "c2",
      tool: "webfetch",
      subject: "https://example.invalid",
      stage: 1,
      verdict: "allow",
      reason: "",
      model: "glm-5.2",
    })

    const lines = (await Bun.file(store.file).text())
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as StoreRecord)
    const audit = lines.filter((record) => record.type === "auto-verdict")
    expect(audit).toHaveLength(2)
    expect(audit[0]).toMatchObject({ verdict: "block", stage: 2, subject: "rm -rf /" })
    expect(audit[1]).toMatchObject({ verdict: "allow", stage: 1, tool: "webfetch" })

    const loaded = await loadSession("/tmp/zcode-test", session.id)
    expect(loaded.session.items).toHaveLength(1)
    expect(loaded.session.items[0]?.type).toBe("user")
    expect(JSON.stringify(loaded.session.items)).not.toContain("auto-verdict")
  } finally {
    restore()
    if (prevXdg === undefined) delete process.env["XDG_DATA_HOME"]
    else process.env["XDG_DATA_HOME"] = prevXdg
    await rm(dataDir, { recursive: true, force: true })
  }
})
