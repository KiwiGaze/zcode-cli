import { test, expect } from "bun:test"
import { z } from "zod"
import { query } from "@/agent/query"
import { createSession, recordUsage, type Session } from "@/session/session"
import { createTaskTool } from "@/tools/task"
import { createTodoTool } from "@/tools/todo"
import { runSubagent } from "@/subagents/runner"
import { defineTool, type AnyTool, type ToolContext } from "@/tools/registry"
import { okResult } from "@/tools/types"
import { FileState } from "@/tools/file-state"
import type { AgentEvent } from "@/agent/events"
import type { AgentRuntime } from "@/agent/runtime"
import type { AgentDefinition } from "@/subagents/types"
import { mockLLM, type MockLLM } from "../support/mock-llm"
import { testConfig, withApiKey } from "../support/config"
import { testRuntime } from "../support/runtime"

function agent(over: Partial<AgentDefinition> & { name: string }): AgentDefinition {
  return {
    description: `the ${over.name} agent`,
    prompt: `You are the ${over.name} agent.`,
    source: "disk",
    ...over,
  }
}

function recordingTool(name: string, runs: string[], asks = false): AnyTool {
  return defineTool<{ command: string }>({
    name,
    description: `the ${name} tool`,
    inputSchema: z.object({ command: z.string() }),
    permission: asks
      ? (input, ctx) => ({
          tool: name,
          callId: ctx.callId,
          title: `${name}: ${input.command}`,
          key: `${name}:${input.command}`,
          subject: input.command,
        })
      : () => null,
    execute: async (input) => {
      runs.push(`${name}:${input.command}`)
      return okResult(`ran ${input.command}`)
    },
  })
}

function context(usageSession: Session = createSession("/tmp/zcode-test")): ToolContext {
  return {
    cwd: "/tmp/zcode-test",
    signal: new AbortController().signal,
    callId: "c1",
    sessionId: "s1",
    usageSession,
    files: new FileState(),
    onProgress: () => {},
  }
}

test("a child starts against the parent session's remaining cost budget", async () => {
  const restore = withApiKey()
  try {
    const llm = mockLLM([{ text: "must not run" }])
    const runtime = parentRuntime([], [], llm)
    runtime.config = { ...runtime.config, budget: { maxCostUsd: 1, warnAt: 0.8 } }
    const usageSession = createSession("/tmp/zcode-test")
    recordUsage(usageSession, runtime.config.model, {
      input: 1_000_000,
      output: 0,
      reasoning: 0,
      cachedInput: 0,
    })

    const result = await runSubagent(
      runtime,
      {
        description: "budgeted child",
        prompt: "inspect the repo",
        system: "test child",
        toolNames: new Set(),
        config: runtime.config,
        decidePermission: () => "deny",
      },
      context(usageSession),
    )

    expect(result.status).toBe("error")
    expect(llm.calls).toHaveLength(0)
  } finally {
    restore()
  }
})

function readOnlyTools(runs: string[]): AnyTool[] {
  return ["read", "grep", "glob", "webfetch"].map((name) => recordingTool(name, runs))
}

/** A parent runtime whose registry holds the real tool names an agent might be granted. */
function parentRuntime(agents: AgentDefinition[], runs: string[], llm: MockLLM): AgentRuntime {
  const config = testConfig()
  const runtime = testRuntime(config, [
    ...readOnlyTools(runs),
    recordingTool("bash", runs, true),
    recordingTool("write", runs, true),
    recordingTool("skill", runs),
  ])
  runtime.agents = agents
  runtime.llm = llm.fn
  runtime.registry.register(createTaskTool(runtime))
  return runtime
}

async function runTask(
  runtime: AgentRuntime,
  input: Record<string, unknown>,
): Promise<{ status: string; output: string }> {
  const tool = runtime.registry.get("task")!
  const parsed = tool.parse(input)
  if (!parsed.ok) return { status: "invalid", output: parsed.error }
  const result = await tool.execute(parsed.value, context())
  return { status: result.status, output: result.output }
}

test("an unknown subagent type returns an error listing the valid ones", async () => {
  const restore = withApiKey()
  try {
    const runtime = parentRuntime(
      [agent({ name: "explore" }), agent({ name: "auditor" })],
      [],
      mockLLM([{ text: "x" }]),
    )
    const result = await runTask(runtime, { description: "d", prompt: "p", subagent_type: "nope" })

    expect(result.status).toBe("error")
    expect(result.output).toContain("unknown subagent type: nope")
    expect(result.output).toContain("explore")
    expect(result.output).toContain("auditor")
  } finally {
    restore()
  }
})

test("a custom agent child gets the read-only base plus its granted tools", async () => {
  const restore = withApiKey()
  try {
    const runs: string[] = []
    const llm = mockLLM([{ text: "child report" }])
    const runtime = parentRuntime([agent({ name: "auditor", allowedTools: ["bash(git:*)"] })], runs, llm)

    const result = await runTask(runtime, { description: "audit", prompt: "look", subagent_type: "auditor" })

    expect(result.status).toBe("ok")
    const childTools = llm.calls[0]?.tools.map((tool) => tool.name).sort() ?? []
    expect(childTools).toEqual(["bash", "glob", "grep", "read", "webfetch"])
  } finally {
    restore()
  }
})

test("Claude-style tool names resolve to local child tools", async () => {
  const restore = withApiKey()
  try {
    const runs: string[] = []
    const llm = mockLLM([
      { toolCalls: [{ callId: "w1", name: "write", input: { command: "/tmp/report" } }] },
      { text: "child report" },
    ])
    const runtime = parentRuntime(
      [agent({ name: "builder", allowedTools: ["Read", "Bash(git:*)", "Write"] })],
      runs,
      llm,
    )

    await runTask(runtime, { description: "build", prompt: "work", subagent_type: "builder" })

    const childTools = llm.calls[0]?.tools.map((tool) => tool.name).sort() ?? []
    expect(childTools).toEqual(["bash", "glob", "grep", "read", "webfetch", "write"])
    expect(runs).toContain("write:/tmp/report")
  } finally {
    restore()
  }
})

test("a child todowrite grant cannot replace the parent's todos", async () => {
  const restore = withApiKey()
  try {
    const llm = mockLLM([
      {
        toolCalls: [
          {
            callId: "todo1",
            name: "todowrite",
            input: { todos: [{ id: "child", content: "child work", status: "in_progress" }] },
          },
        ],
      },
      { text: "child report" },
    ])
    const runtime = parentRuntime([agent({ name: "planner", allowedTools: ["TodoWrite"] })], [], llm)
    runtime.registry.register(createTodoTool(runtime.todos))

    await runTask(runtime, { description: "plan", prompt: "make a plan", subagent_type: "planner" })

    expect(runtime.todos.list()).toEqual([])
    expect(llm.calls[0]?.tools.map((tool) => tool.name)).toContain("todowrite")
  } finally {
    restore()
  }
})

test("parent-control tools never enter a child toolset, even when granted", async () => {
  const restore = withApiKey()
  try {
    const runs: string[] = []
    const llm = mockLLM([{ text: "child report" }])
    const runtime = parentRuntime(
      [agent({ name: "greedy", allowedTools: ["task", "skill", "toolsearch", "schedulewakeup", "read"] })],
      runs,
      llm,
    )
    runtime.registry.register(recordingTool("toolsearch", runs))
    runtime.registry.register(recordingTool("schedulewakeup", runs))

    await runTask(runtime, { description: "d", prompt: "p", subagent_type: "greedy" })

    const childTools = llm.calls[0]?.tools.map((tool) => tool.name) ?? []
    expect(childTools).not.toContain("task")
    expect(childTools).not.toContain("skill")
    expect(childTools).not.toContain("toolsearch")
    expect(childTools).not.toContain("schedulewakeup")
    expect(childTools).toContain("read")
  } finally {
    restore()
  }
})

test("unknown granted tool names are dropped and reported", async () => {
  const restore = withApiKey()
  try {
    const runs: string[] = []
    const llm = mockLLM([{ text: "child report" }])
    const runtime = parentRuntime([agent({ name: "typo", allowedTools: ["read", "nonexistent"] })], runs, llm)

    const progress: string[] = []
    const tool = runtime.registry.get("task")!
    const parsed = tool.parse({ description: "d", prompt: "p", subagent_type: "typo" })
    if (!parsed.ok) throw new Error(parsed.error)
    await tool.execute(parsed.value, { ...context(), onProgress: (chunk) => progress.push(chunk) })

    const childTools = llm.calls[0]?.tools.map((tool) => tool.name) ?? []
    expect(childTools).toContain("read")
    expect(childTools).not.toContain("nonexistent")
    expect(progress.join("")).toContain("tools not granted: nonexistent")
  } finally {
    restore()
  }
})

test("an elevating agent requires parent consent; a read-only one does not", () => {
  const runtime = parentRuntime(
    [
      agent({ name: "explore", allowedTools: ["read", "grep", "glob", "webfetch"] }),
      agent({ name: "auditor", allowedTools: ["bash(git:*)"] }),
    ],
    [],
    mockLLM([{ text: "x" }]),
  )
  const tool = runtime.registry.get("task")!

  expect(tool.permission({ description: "d", prompt: "p", subagent_type: "explore" }, context())).toBeNull()
  expect(tool.permission({ description: "d", prompt: "p" }, context())).toBeNull()

  const request = tool.permission({ description: "d", prompt: "p", subagent_type: "auditor" }, context())
  expect(request).not.toBeNull()
  expect(request?.tool).toBe("task")
  expect(request?.title).toContain("auditor")
  expect(request?.detail).toContain("bash(git:*)")
  expect(request?.key).toContain("agent:auditor:")
})

test("a session approval does not authorize broader grants after an agent reload", () => {
  const runtime = parentRuntime(
    [agent({ name: "auditor", allowedTools: ["bash(git:*)"] })],
    [],
    mockLLM([{ text: "x" }]),
  )
  const tool = runtime.registry.get("task")!
  const input = { description: "d", prompt: "p", subagent_type: "auditor" }
  const first = tool.permission(input, context())
  expect(first).not.toBeNull()
  runtime.permissions.applyDecision(first!, "allow-session")
  expect(runtime.permissions.evaluate(first!)).toBe("allow")

  runtime.agents = [agent({ name: "auditor", allowedTools: ["bash(git:*)", "bash(kubectl:*)"] })]
  const broadened = tool.permission(input, context())

  expect(broadened).not.toBeNull()
  expect(broadened?.key).not.toBe(first?.key)
  expect(runtime.permissions.evaluate(broadened!)).toBe("ask")
})

test("granted commands are auto-approved in the child and everything else is denied", async () => {
  const restore = withApiKey()
  try {
    const runs: string[] = []
    const llm = mockLLM([
      {
        toolCalls: [
          { callId: "k1", name: "bash", input: { command: "git status" } },
          { callId: "k2", name: "bash", input: { command: "rm -rf /" } },
          { callId: "k3", name: "write", input: { command: "/etc/passwd" } },
        ],
      },
      { text: "child report" },
    ])
    const runtime = parentRuntime([agent({ name: "auditor", allowedTools: ["bash(git:*)"] })], runs, llm)

    const result = await runTask(runtime, { description: "audit", prompt: "look", subagent_type: "auditor" })

    expect(result.status).toBe("ok")
    // Only the granted command ran; the ungranted one and the ungranted tool were refused.
    expect(runs).toEqual(["bash:git status"])
    expect(runs).not.toContain("bash:rm -rf /")
    expect(runs).not.toContain("write:/etc/passwd")
  } finally {
    restore()
  }
})

test("parent session grants cannot widen a child's command grant", async () => {
  const restore = withApiKey()
  try {
    const runs: string[] = []
    const llm = mockLLM([
      { toolCalls: [{ callId: "k1", name: "bash", input: { command: "rm -rf /" } }] },
      { text: "child report" },
    ])
    const runtime = parentRuntime([agent({ name: "auditor", allowedTools: ["bash(git:*)"] })], runs, llm)
    runtime.permissions.grantSession("bash:rm -rf /")

    const result = await runTask(runtime, { description: "audit", prompt: "look", subagent_type: "auditor" })

    expect(result.status).toBe("ok")
    expect(runs).toEqual([])
  } finally {
    restore()
  }
})

test("a child permission decider cannot grant the parent session", async () => {
  const restore = withApiKey()
  try {
    const runs: string[] = []
    const llm = mockLLM([
      { toolCalls: [{ callId: "k1", name: "bash", input: { command: "git status" } }] },
      { text: "child report" },
    ])
    const runtime = parentRuntime([], runs, llm)
    const request = {
      tool: "bash",
      callId: "probe",
      title: "bash: git status",
      key: "bash:git status",
      subject: "git status",
    }

    const result = await runSubagent(
      runtime,
      {
        description: "malicious child",
        prompt: "run git status",
        system: "test child",
        toolNames: new Set(["bash"]),
        config: runtime.config,
        decidePermission: () => "allow-session",
      },
      context(),
    )

    expect(result.status).toBe("error")
    expect(runtime.permissions.evaluate(request)).toBe("ask")
    expect(runs).toEqual([])
  } finally {
    restore()
  }
})

test("a child receives project instructions once outside its role system prompt", async () => {
  const restore = withApiKey()
  try {
    const runs: string[] = []
    const llm = mockLLM([{ text: "child report" }])
    const runtime = parentRuntime([agent({ name: "auditor", prompt: "AUDITOR ROLE BODY" })], runs, llm)
    runtime.instructions = [{ path: "/repo/AGENTS.md", content: "PROJECT RULE ONE" }]

    await runTask(runtime, { description: "d", prompt: "p", subagent_type: "auditor" })

    const system = llm.calls[0]?.system ?? ""
    expect(system).toContain("AUDITOR ROLE BODY")
    expect(system).toContain("Working directory:")
    expect(system).not.toContain("PROJECT RULE ONE")
    const request = `${system}\n${JSON.stringify(llm.calls[0]?.messages ?? [])}`
    expect(request.match(/PROJECT RULE ONE/g)).toHaveLength(1)
    // The parent's identity and skill catalog belong to the parent.
    expect(system).not.toContain("You are ZCode CLI")
    expect(system).not.toContain("Available skills")
  } finally {
    restore()
  }
})

test("a model override reaches the child only", async () => {
  const restore = withApiKey()
  try {
    const runs: string[] = []
    const parentLlm = mockLLM([
      { toolCalls: [{ callId: "t1", name: "task", input: { description: "d", prompt: "p", subagent_type: "cheap" } }] },
      { text: "parent done" },
    ])
    const runtime = parentRuntime([agent({ name: "cheap", model: "glm-4.7" })], runs, parentLlm)
    const config = testConfig()
    const session = createSession("/tmp/zcode-test")

    const events: AgentEvent[] = []
    for await (const event of query({
      prompt: "delegate",
      session,
      config,
      runtime,
      signal: new AbortController().signal,
      deps: { llm: parentLlm.fn },
    })) {
      events.push(event)
    }

    // calls[0] and calls[2] are the parent's; calls[1] is the child's.
    expect(parentLlm.calls).toHaveLength(3)
    expect(parentLlm.calls[0]?.system).toContain("You are ZCode CLI")
    expect(parentLlm.calls[1]?.system).toContain("cheap agent")
    // The override has to reach the wire, and only on the child's request.
    expect(parentLlm.calls[1]?.model).toBe("glm-4.7")
    expect(parentLlm.calls[0]?.model).toBe(config.model)
    expect(parentLlm.calls[2]?.model).toBe(config.model)
    expect(session.usageByModel["glm-4.7"]).toBeDefined()
  } finally {
    restore()
  }
})

test("an unpriced child model surfaces its unenforced cost warning", async () => {
  const restore = withApiKey()
  try {
    const llm = mockLLM([{ text: "child report" }])
    const runtime = parentRuntime([agent({ name: "custom", model: "custom-unpriced" })], [], llm)
    runtime.config = { ...runtime.config, budget: { maxCostUsd: 1, warnAt: 0.8 } }
    const progress: string[] = []
    const tool = runtime.registry.get("task")!
    const parsed = tool.parse({ description: "d", prompt: "p", subagent_type: "custom" })
    if (!parsed.ok) throw new Error(parsed.error)

    await tool.execute(parsed.value, { ...context(), onProgress: (chunk) => progress.push(chunk) })

    expect(progress.join("")).toContain('cost unknown for model "custom-unpriced"')
    expect(progress.join("")).toContain("not enforced")
  } finally {
    restore()
  }
})

test("omitting subagent_type resolves the default explore type", async () => {
  const restore = withApiKey()
  try {
    const runs: string[] = []
    const llm = mockLLM([{ text: "child report" }])
    const runtime = parentRuntime(
      [agent({ name: "explore", allowedTools: ["read", "grep", "glob", "webfetch"] })],
      runs,
      llm,
    )

    const result = await runTask(runtime, { description: "search", prompt: "find it" })

    expect(result.status).toBe("ok")
    const childTools = llm.calls[0]?.tools.map((tool) => tool.name).sort() ?? []
    expect(childTools).toEqual(["glob", "grep", "read", "webfetch"])
  } finally {
    restore()
  }
})

test("the task description advertises every discovered type", () => {
  const runtime = parentRuntime(
    [agent({ name: "explore" }), agent({ name: "security-review", description: "audits a diff" })],
    [],
    mockLLM([{ text: "x" }]),
  )
  const description = runtime.registry.get("task")!.description

  expect(description).toContain("Available subagent types:")
  expect(description).toContain("- explore:")
  expect(description).toContain("- security-review: audits a diff")
})

test("a child can use the read-only base tools it always receives", async () => {
  const restore = withApiKey()
  try {
    const runs: string[] = []
    const llm = mockLLM([
      { toolCalls: [{ callId: "w1", name: "webfetch", input: { command: "https://example.invalid" } }] },
      { text: "child report" },
    ])
    // Grants name only bash, but every child also receives the read-only base. webfetch is the one
    // base tool with a permission hook; it stays usable because policy allows it by default, so the
    // headless deny-what-is-not-granted rule never sees it.
    const config = testConfig()
    const runtime = testRuntime(config, [
      ...["read", "grep", "glob"].map((name) => recordingTool(name, runs)),
      recordingTool("webfetch", runs, true),
      recordingTool("bash", runs, true),
    ])
    runtime.agents = [agent({ name: "auditor", allowedTools: ["bash(git:*)"] })]
    runtime.llm = llm.fn
    runtime.registry.register(createTaskTool(runtime))

    const result = await runTask(runtime, { description: "audit", prompt: "look", subagent_type: "auditor" })

    expect(result.status).toBe("ok")
    expect(runs).toEqual(["webfetch:https://example.invalid"])
  } finally {
    restore()
  }
})
