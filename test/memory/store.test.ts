import { test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { listMemories, loadMemoryIndex, memoryFreshnessWarning, saveMemory, MEMORY_INDEX_FILE } from "@/memory/store"

const DAY_MS = 86_400_000

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "zcode-memory-store-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

test("saveMemory writes a frontmatter file and rebuilds the index", async () => {
  const first = await saveMemory(dir, {
    name: "Editor prefs",
    description: "prefers tabs, 100-col wrap",
    type: "user",
    content: "The user works in nvim and wants 100-column lines.",
  })
  const second = await saveMemory(dir, {
    name: "zcode port",
    description: "the GLM port is in flight",
    type: "project",
    content: "Porting mini-claude mechanisms into zcode-cli.",
  })

  expect(first).toBe("user_editor_prefs.md")
  expect(second).toBe("project_zcode_port.md")

  const entries = await listMemories(dir)
  expect(entries.map((entry) => entry.filename).sort()).toEqual([first, second].sort())
  const prefs = entries.find((entry) => entry.filename === first)
  expect(prefs?.name).toBe("Editor prefs")
  expect(prefs?.description).toBe("prefers tabs, 100-col wrap")
  expect(prefs?.type).toBe("user")
  expect(prefs?.content).toBe("The user works in nvim and wants 100-column lines.")

  const index = await loadMemoryIndex(dir)
  expect(index).toContain("Editor prefs")
  expect(index).toContain("zcode port")
  expect(index).toContain(first)
  expect(index).toContain(second)
})

test("listMemories skips corrupt files", async () => {
  await saveMemory(dir, { name: "good one", description: "fine", type: "project", content: "body" })
  await writeFile(path.join(dir, "project_broken.md"), "---\nname: [unclosed\n---\nbody\n", "utf8")
  await writeFile(path.join(dir, "project_headerless.md"), "no frontmatter at all\n", "utf8")

  const entries = await listMemories(dir)
  expect(entries.map((entry) => entry.filename)).toEqual(["project_good_one.md"])
})

test("loadMemoryIndex truncates past 200 lines", async () => {
  for (let i = 0; i < 201; i++) {
    await writeFile(
      path.join(dir, `project_bulk_${i}.md`),
      `---\nname: bulk ${i}\ndescription: entry ${i}\ntype: project\n---\nbody ${i}\n`,
      "utf8",
    )
  }
  // One real save rebuilds the index over everything already on disk.
  await saveMemory(dir, { name: "trigger", description: "rebuild", type: "project", content: "x" })

  const index = await loadMemoryIndex(dir)
  expect(index.split("\n").length).toBeLessThanOrEqual(203)
  expect(index).toContain("[... truncated, too many memory entries ...]")
})

test("memoryFreshnessWarning labels memories older than one day", () => {
  const stale = memoryFreshnessWarning(Date.now() - 2 * DAY_MS)
  expect(stale).toContain("2 days old")
  expect(stale).toContain("Verify against current code")

  expect(memoryFreshnessWarning(Date.now() - 3600_000)).toBe("")
  expect(memoryFreshnessWarning(Date.now())).toBe("")
})

test("an out-of-band edit to the directory is healed by the next index rebuild", async () => {
  await saveMemory(dir, { name: "one", description: "first", type: "user", content: "a" })
  await writeFile(path.join(dir, MEMORY_INDEX_FILE), "# Memory index\n\nstale nonsense\n", "utf8")

  await saveMemory(dir, { name: "two", description: "second", type: "user", content: "b" })

  const index = await loadMemoryIndex(dir)
  expect(index).not.toContain("stale nonsense")
  expect(index).toContain("one")
  expect(index).toContain("two")
})
