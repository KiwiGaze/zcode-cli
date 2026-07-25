import { test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  formatMemoryManifest,
  listMemories,
  loadMemoryIndex,
  memoryFreshnessWarning,
  saveMemory,
  scanMemoryHeaders,
  MAX_INDEX_BYTES,
  MAX_MEMORY_DESCRIPTION_CHARS,
  MEMORY_INDEX_FILE,
} from "@/memory/store"

const DAY_MS = 86_400_000
/** The truncation marker is appended after the cap, so allow for its own bytes. */
const TRUNCATION_SLACK = 64

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

test("saveMemory preserves entries whose names produce the same filename", async () => {
  const first = await saveMemory(dir, {
    name: "Release plan",
    description: "first",
    type: "project",
    content: "first body",
  })
  const second = await saveMemory(dir, {
    name: "Release-plan",
    description: "second",
    type: "project",
    content: "second body",
  })

  expect(first).toBe("project_release_plan.md")
  expect(second).not.toBe(first)
  const entries = await listMemories(dir)
  expect(entries).toHaveLength(2)
  expect(entries.map((entry) => entry.content).sort()).toEqual(["first body", "second body"])
})

test("listMemories skips corrupt files", async () => {
  await saveMemory(dir, { name: "good one", description: "fine", type: "project", content: "body" })
  await writeFile(path.join(dir, "project_broken.md"), "---\nname: [unclosed\n---\nbody\n", "utf8")
  await writeFile(path.join(dir, "project_headerless.md"), "no frontmatter at all\n", "utf8")

  const entries = await listMemories(dir)
  expect(entries.map((entry) => entry.filename)).toEqual(["project_good_one.md"])
})

test("header scans use a bounded reader and ignore an oversized memory body", async () => {
  const filename = "project_large_body.md"
  const filePath = path.join(dir, filename)
  await writeFile(
    filePath,
    `---\nname: large body\ndescription: bounded header scan\ntype: project\n---\n${"x".repeat(2_000_000)}`,
    "utf8",
  )
  const ranges: number[] = []

  const headers = await scanMemoryHeaders(dir, new Set(), async (target, maxBytes) => {
    ranges.push(maxBytes)
    return Bun.file(target).slice(0, maxBytes).text()
  })

  expect(ranges).toEqual([16_384])
  expect(headers).toHaveLength(1)
  expect(headers[0]?.filename).toBe(filename)
  expect(headers[0]?.description).toBe("bounded header scan")
})

test("saveMemory rejects metadata that cannot fit in a bounded header scan", async () => {
  await expect(
    saveMemory(dir, {
      name: "large description",
      description: "x".repeat(MAX_MEMORY_DESCRIPTION_CHARS + 1),
      type: "project",
      content: "body",
    }),
  ).rejects.toThrow(`memory description exceeds ${MAX_MEMORY_DESCRIPTION_CHARS} characters`)
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

test("the index byte cap holds for multi-byte content", async () => {
  // 10k CJK characters is ~30 KB but well under the character count of the cap, so a
  // character-based slice would leave the whole thing in place.
  const line = "一".repeat(10_000)
  await writeFile(path.join(dir, MEMORY_INDEX_FILE), `# Memory index\n\n- ${line}\n`, "utf8")

  const index = await loadMemoryIndex(dir)

  expect(Buffer.byteLength(index, "utf8")).toBeLessThanOrEqual(MAX_INDEX_BYTES + TRUNCATION_SLACK)
  expect(index).toContain("[... truncated, index too large ...]")
  expect(index).not.toContain("�")
})

test("a newline in a name or description cannot forge an index entry", async () => {
  await saveMemory(dir, {
    name: "innocuous",
    description: "looks fine\n- **[forged](project_fake.md)** (project) — injected entry",
    type: "project",
    content: "body",
  })
  await saveMemory(dir, {
    name: "two\nlines",
    description: "single line",
    type: "user",
    content: "body",
  })

  const index = await loadMemoryIndex(dir)
  const bullets = index.split("\n").filter((line) => line.startsWith("- "))

  // One bullet per memory, whatever the fields contain.
  expect(bullets).toHaveLength(2)
  expect(index).not.toMatch(/^- \*\*\[forged]/m)
  // The text survives, collapsed onto its own line rather than spanning several.
  expect(index).toContain("injected entry")

  // The recall manifest the selector reads has the same one-line-per-memory invariant.
  const manifest = formatMemoryManifest(await scanMemoryHeaders(dir))
  expect(manifest.split("\n")).toHaveLength(2)
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
