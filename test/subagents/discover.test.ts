import { test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { discoverAgents } from "@/subagents/discover"
import { ConfigSchema, type ResolvedConfig } from "@/config/config"

let project: string
let home: string
let restoreEnv: () => void

beforeEach(async () => {
  project = await mkdtemp(path.join(tmpdir(), "zcode-agents-proj-"))
  home = await mkdtemp(path.join(tmpdir(), "zcode-agents-home-"))
  const prevHome = process.env["HOME"]
  const prevXdg = process.env["XDG_CONFIG_HOME"]
  process.env["HOME"] = home
  process.env["XDG_CONFIG_HOME"] = path.join(home, ".config")
  restoreEnv = () => {
    if (prevHome === undefined) delete process.env["HOME"]
    else process.env["HOME"] = prevHome
    if (prevXdg === undefined) delete process.env["XDG_CONFIG_HOME"]
    else process.env["XDG_CONFIG_HOME"] = prevXdg
  }
  // A .git marker stops the project chain from walking above the temp dir.
  await mkdir(path.join(project, ".git"), { recursive: true })
})

afterEach(async () => {
  restoreEnv()
  await rm(project, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

function config(over: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return { ...ConfigSchema.parse({}), cwd: project, ...over }
}

async function writeAgent(dir: string, name: string, body: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, `${name}.md`), body, "utf8")
}

test("discovers a project agent and keeps the built-ins", async () => {
  await writeAgent(
    path.join(project, ".zcode", "agents"),
    "security-review",
    ["---", "description: audits a diff", "allowed-tools: read, bash(git:*)", "---", "You audit diffs."].join("\n"),
  )

  const { agents, warnings } = await discoverAgents(project, config())

  expect(warnings).toEqual([])
  const names = agents.map((agent) => agent.name)
  expect(names).toContain("security-review")
  expect(names).toContain("explore")
  expect(names).toContain("plan")

  const found = agents.find((agent) => agent.name === "security-review")
  expect(found?.allowedTools).toEqual(["read", "bash(git:*)"])
  expect(found?.prompt).toBe("You audit diffs.")
  expect(found?.source).toBe("disk")
})

test("skips files with no description or an empty body, with a warning", async () => {
  const dir = path.join(project, ".zcode", "agents")
  await writeAgent(dir, "nodesc", ["---", "model: glm-4.7", "---", "has a body"].join("\n"))
  await writeAgent(dir, "nobody", ["---", "description: has a description", "---", ""].join("\n"))
  await writeAgent(dir, "broken", ["---", "description: [unclosed", "---", "body"].join("\n"))
  await writeAgent(dir, "good", ["---", "description: fine", "---", "body"].join("\n"))

  const { agents, warnings } = await discoverAgents(project, config())

  const names = agents.map((agent) => agent.name)
  expect(names).toContain("good")
  expect(names).not.toContain("nodesc")
  expect(names).not.toContain("nobody")
  expect(names).not.toContain("broken")
  expect(warnings).toHaveLength(3)
  expect(warnings.join("\n")).toContain("missing description")
  expect(warnings.join("\n")).toContain("empty body")
})

test("project overrides user overrides built-in", async () => {
  await writeAgent(
    path.join(home, ".config", "zcode", "agents"),
    "explore",
    ["---", "description: user explore", "---", "USER PROMPT"].join("\n"),
  )
  const userOnly = await discoverAgents(project, config())
  expect(userOnly.agents.find((agent) => agent.name === "explore")?.prompt).toBe("USER PROMPT")

  await writeAgent(
    path.join(project, ".zcode", "agents"),
    "explore",
    ["---", "description: project explore", "---", "PROJECT PROMPT"].join("\n"),
  )
  const both = await discoverAgents(project, config())
  const explore = both.agents.find((agent) => agent.name === "explore")
  expect(explore?.prompt).toBe("PROJECT PROMPT")
  expect(explore?.description).toBe("project explore")
  // Exactly one definition survives per name.
  expect(both.agents.filter((agent) => agent.name === "explore")).toHaveLength(1)
})

test("the native dir wins over the .claude interop dir at the same level", async () => {
  await writeAgent(
    path.join(project, ".claude", "agents"),
    "reviewer",
    ["---", "description: claude reviewer", "tools: read", "---", "CLAUDE BODY"].join("\n"),
  )
  const interopOnly = await discoverAgents(project, config())
  expect(interopOnly.agents.find((agent) => agent.name === "reviewer")?.prompt).toBe("CLAUDE BODY")

  await writeAgent(
    path.join(project, ".zcode", "agents"),
    "reviewer",
    ["---", "description: native reviewer", "---", "NATIVE BODY"].join("\n"),
  )
  const both = await discoverAgents(project, config())
  expect(both.agents.find((agent) => agent.name === "reviewer")?.prompt).toBe("NATIVE BODY")

  const off = await discoverAgents(project, config({ agents: { paths: [], disabled: [], interop: { claude: false } } }))
  expect(off.agents.find((agent) => agent.name === "reviewer")?.prompt).toBe("NATIVE BODY")
})

test("interop can be turned off entirely", async () => {
  await writeAgent(
    path.join(project, ".claude", "agents"),
    "reviewer",
    ["---", "description: claude reviewer", "---", "CLAUDE BODY"].join("\n"),
  )
  const off = await discoverAgents(project, config({ agents: { paths: [], disabled: [], interop: { claude: false } } }))
  expect(off.agents.map((agent) => agent.name)).not.toContain("reviewer")
})

test("disabled names are filtered, including built-ins", async () => {
  await writeAgent(path.join(project, ".zcode", "agents"), "custom", ["---", "description: d", "---", "b"].join("\n"))

  const { agents } = await discoverAgents(
    project,
    config({ agents: { paths: [], disabled: ["plan", "custom"], interop: { claude: true } } }),
  )

  const names = agents.map((agent) => agent.name)
  expect(names).toContain("explore")
  expect(names).not.toContain("plan")
  expect(names).not.toContain("custom")
})

test("extra config paths are scanned", async () => {
  const extra = await mkdtemp(path.join(tmpdir(), "zcode-agents-extra-"))
  try {
    await writeAgent(extra, "extra-agent", ["---", "description: from a config path", "---", "body"].join("\n"))
    const { agents } = await discoverAgents(
      project,
      config({ agents: { paths: [extra], disabled: [], interop: { claude: true } } }),
    )
    expect(agents.map((agent) => agent.name)).toContain("extra-agent")
  } finally {
    await rm(extra, { recursive: true, force: true })
  }
})

test("a linked worktree's .git file is recognized as the repo root", async () => {
  // A linked worktree or submodule has `.git` as a *file* pointing at the real gitdir. It must be
  // created outside any other repository, or a parent .git directory would rescue the walk.
  const worktree = await mkdtemp(path.join(tmpdir(), "zcode-agents-wt-"))
  const nested = path.join(worktree, "packages", "app")
  await mkdir(nested, { recursive: true })
  await writeFile(path.join(worktree, ".git"), "gitdir: /elsewhere/.git/worktrees/wt\n", "utf8")
  await writeAgent(
    path.join(worktree, ".zcode", "agents"),
    "worktree-agent",
    ["---", "description: lives at the worktree root", "---", "body"].join("\n"),
  )

  // Discovery starts deep inside the worktree and must still walk up to its root.
  try {
    const { agents } = await discoverAgents(nested, config({ cwd: nested }))
    expect(agents.map((agent) => agent.name)).toContain("worktree-agent")
  } finally {
    await rm(worktree, { recursive: true, force: true })
  }
})
