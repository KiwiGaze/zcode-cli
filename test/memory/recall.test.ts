import { test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createMemorySession, isQuerySubstantial, selectRelevantMemories } from "@/memory/recall"
import { saveMemory, MAX_MEMORY_BYTES_PER_FILE } from "@/memory/store"
import type { CompleteFn, CompleteRequest } from "@/llm/complete"
import { testConfig, withApiKey } from "../support/config"

let dir: string
let restoreKey: () => void

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "zcode-memory-recall-"))
  restoreKey = withApiKey()
})
afterEach(async () => {
  restoreKey()
  await rm(dir, { recursive: true, force: true })
})

interface FakeComplete {
  fn: CompleteFn
  calls: CompleteRequest[]
}

function fakeComplete(reply: string | (() => Promise<string>)): FakeComplete {
  const calls: CompleteRequest[] = []
  const fn: CompleteFn = async (request) => {
    calls.push(request)
    return typeof reply === "string" ? reply : await reply()
  }
  return { fn, calls }
}

async function seed(count: number): Promise<string[]> {
  const names: string[] = []
  for (let i = 0; i < count; i++) {
    names.push(
      await saveMemory(dir, {
        name: `topic ${i}`,
        description: `about topic ${i}`,
        type: "project",
        content: `body for topic ${i}`,
      }),
    )
  }
  return names
}

/** Poll microtask/macrotask turns until the condition holds, so no test depends on a fixed delay. */
async function settle(check: () => boolean, ticks = 50): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

test("isQuerySubstantial accepts CJK and multi-word, rejects trivial input", () => {
  expect(isQuerySubstantial("")).toBe(false)
  expect(isQuerySubstantial("   ")).toBe(false)
  expect(isQuerySubstantial("ok")).toBe(false)
  expect(isQuerySubstantial("fix the bug")).toBe(true)
  expect(isQuerySubstantial("修复")).toBe(true)
  expect(isQuerySubstantial("修")).toBe(false)
})

test("selectRelevantMemories returns only model-chosen files, capped at five", async () => {
  const files = await seed(8)
  const chosen = [...files.slice(0, 5), files[5], files[6], "project_does_not_exist.md", "../../etc/passwd"]
  const complete = fakeComplete(JSON.stringify({ selected_memories: chosen }))

  const memories = await selectRelevantMemories({
    dir,
    config: testConfig(),
    complete: complete.fn,
    query: "what am I working on",
    alreadySurfaced: new Set(),
    signal: new AbortController().signal,
  })

  expect(memories).toHaveLength(5)
  for (const memory of memories) {
    expect(memory.path.startsWith(dir)).toBe(true)
    expect(files).toContain(path.basename(memory.path))
  }
  // The selector saw descriptions only — never a memory body.
  expect(complete.calls).toHaveLength(1)
  expect(complete.calls[0]?.prompt).toContain("about topic 0")
  expect(complete.calls[0]?.prompt).not.toContain("body for topic 0")
  expect(complete.calls[0]?.temperature).toBe(0)
})

test("selectRelevantMemories tolerates fenced or malformed JSON", async () => {
  const files = await seed(2)
  const config = testConfig()
  const base = {
    dir,
    config,
    query: "anything at all",
    alreadySurfaced: new Set<string>(),
    signal: new AbortController().signal,
  }

  const fenced = fakeComplete('Sure!\n```json\n{"selected_memories": ["' + files[0] + '"]}\n```\nHope that helps.')
  const fromFence = await selectRelevantMemories({ ...base, complete: fenced.fn })
  expect(fromFence.map((memory) => path.basename(memory.path))).toEqual([files[0]!])

  const prose = fakeComplete("I could not find anything useful in those memories.")
  expect(await selectRelevantMemories({ ...base, complete: prose.fn })).toEqual([])

  const broken = fakeComplete('{"selected_memories": [unquoted]}')
  expect(await selectRelevantMemories({ ...base, complete: broken.fn })).toEqual([])

  const wrongShape = fakeComplete('{"selected_memories": "not-an-array"}')
  expect(await selectRelevantMemories({ ...base, complete: wrongShape.fn })).toEqual([])
})

test("a settled recall is surfaced and budgeted exactly once", async () => {
  const files = await seed(2)
  const complete = fakeComplete(JSON.stringify({ selected_memories: files }))
  const session = createMemorySession({ config: testConfig(), dir, complete: complete.fn })
  const signal = new AbortController().signal

  session.beginTurn("tell me about topic 0", signal)
  let hit: ReturnType<typeof session.pollInjection> = null
  await settle(() => {
    hit = session.pollInjection()
    return hit !== null
  })
  expect(hit).not.toBeNull()
  expect(hit!.names.sort()).toEqual(["topic_0", "topic_1"])
  // Draining is single-shot: a second poll in the same turn yields nothing.
  expect(session.pollInjection()).toBeNull()

  // Both memories are surfaced now, so the next turn has no candidates and never re-queries.
  session.beginTurn("tell me about topic 0 again", signal)
  await settle(() => false, 5)
  expect(complete.calls).toHaveLength(1)
  expect(session.pollInjection()).toBeNull()

  // A third memory appears: it is offered, the two already-surfaced ones are not.
  const fresh = await saveMemory(dir, { name: "topic 9", description: "about topic 9", type: "project", content: "b9" })
  session.beginTurn("and topic 9 as well", signal)
  await settle(() => complete.calls.length >= 2)
  expect(complete.calls).toHaveLength(2)
  expect(complete.calls[1]?.prompt).toContain(fresh)
  for (const file of files) expect(complete.calls[1]?.prompt).not.toContain(file)
})

test("an injected memory body stays within the per-file byte cap", async () => {
  // ~6 KB of CJK: over the byte cap, but only 2000 characters, so a character-based slice
  // would hand the model the entire body.
  const body = "记".repeat(2000)
  const filename = await saveMemory(dir, {
    name: "large cjk",
    description: "a big one",
    type: "project",
    content: body,
  })
  const complete = fakeComplete(JSON.stringify({ selected_memories: [filename] }))

  const memories = await selectRelevantMemories({
    dir,
    config: testConfig(),
    complete: complete.fn,
    query: "tell me about the big one",
    alreadySurfaced: new Set(),
    signal: new AbortController().signal,
  })

  expect(memories).toHaveLength(1)
  expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(MAX_MEMORY_BYTES_PER_FILE)
  expect(Buffer.byteLength(memories[0]!.content, "utf8")).toBeLessThanOrEqual(MAX_MEMORY_BYTES_PER_FILE + 64)
  expect(memories[0]!.content).toContain("[... truncated, memory file too large ...]")
  expect(memories[0]!.content).not.toContain("�")
})

test("recall failure resolves to nothing and never escapes", async () => {
  await seed(1)
  const complete: CompleteFn = async () => {
    throw new Error("transport exploded")
  }
  const session = createMemorySession({ config: testConfig(), dir, complete })
  session.beginTurn("what do you remember", new AbortController().signal)

  await settle(() => false, 5)
  expect(session.pollInjection()).toBeNull()
})
