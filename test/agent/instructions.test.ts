import { test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { discoverInstructions } from "@/agent/instructions"

let root: string
let prevXdg: string | undefined

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "zcode-instr-"))
  await mkdir(path.join(root, ".git"), { recursive: true })
  prevXdg = process.env["XDG_CONFIG_HOME"]
  process.env["XDG_CONFIG_HOME"] = path.join(root, "no-global-config")
})
afterEach(async () => {
  if (prevXdg === undefined) delete process.env["XDG_CONFIG_HOME"]
  else process.env["XDG_CONFIG_HOME"] = prevXdg
  await rm(root, { recursive: true, force: true })
})

test("collects AGENTS.md up the tree to the git root, nearest last", async () => {
  await writeFile(path.join(root, "AGENTS.md"), "root rules")
  const nested = path.join(root, "packages", "app")
  await mkdir(nested, { recursive: true })
  await writeFile(path.join(nested, "AGENTS.md"), "app rules")

  const found = await discoverInstructions(nested)
  const contents = found.map((file) => file.content)
  expect(contents).toContain("root rules")
  expect(contents).toContain("app rules")
  expect(contents.indexOf("root rules")).toBeLessThan(contents.indexOf("app rules"))
})

test("collects CLAUDE.md as well and skips empty files", async () => {
  await writeFile(path.join(root, "CLAUDE.md"), "claude rules")
  await writeFile(path.join(root, "AGENTS.md"), "   ")
  const found = await discoverInstructions(root)
  expect(found.map((file) => file.content)).toContain("claude rules")
  expect(found.every((file) => file.content.trim().length > 0)).toBe(true)
})

test("returns an empty list when no instruction files exist", async () => {
  const found = await discoverInstructions(root)
  expect(found).toEqual([])
})
