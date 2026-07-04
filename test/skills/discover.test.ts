import { test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm, mkdir, writeFile, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { discoverSkills } from "@/skills/discover"
import { ConfigSchema, type ResolvedConfig } from "@/config/config"

let project: string
let home: string
let restoreEnv: () => void

beforeEach(async () => {
  project = await mkdtemp(path.join(tmpdir(), "zcode-skills-proj-"))
  home = await mkdtemp(path.join(tmpdir(), "zcode-skills-home-"))
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
})

afterEach(async () => {
  restoreEnv()
  await rm(project, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

function config(skills: Record<string, unknown> = {}): ResolvedConfig {
  return { ...ConfigSchema.parse({ skills: { bundled: false, ...skills } }), cwd: project }
}

async function writeSkill(root: string, name: string, contents: string): Promise<void> {
  const dir = path.join(project, root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, "SKILL.md"), contents)
}

test("discovers a .zcode/skills skill and reads its body", async () => {
  await writeSkill(".zcode/skills", "alpha", "---\ndescription: alpha skill\n---\nAlpha body")
  const { skills } = await discoverSkills(project, config())
  const alpha = skills.find((skill) => skill.name === "alpha")
  expect(alpha?.description).toBe("alpha skill")
  expect(alpha?.body).toBe("Alpha body")
  expect(alpha?.source).toBe("disk")
})

test("native .zcode overrides interop .claude for the same name (first-wins)", async () => {
  await writeSkill(".zcode/skills", "dup", "---\ndescription: native\n---\nNATIVE")
  await writeSkill(".claude/skills", "dup", "---\ndescription: interop\n---\nINTEROP")
  const { skills } = await discoverSkills(project, config())
  const dup = skills.filter((skill) => skill.name === "dup")
  expect(dup).toHaveLength(1)
  expect(dup[0]?.body).toBe("NATIVE")
})

test("interop .claude skills are discovered when interop is on", async () => {
  await writeSkill(".claude/skills", "beta", "---\ndescription: beta\n---\nB")
  const { skills } = await discoverSkills(project, config())
  expect(skills.some((skill) => skill.name === "beta")).toBe(true)
})

test("interop.claude=false hides .claude skills", async () => {
  await writeSkill(".claude/skills", "gamma", "---\ndescription: gamma\n---\nG")
  const { skills } = await discoverSkills(project, config({ interop: { claude: false, agents: true } }))
  expect(skills.some((skill) => skill.name === "gamma")).toBe(false)
})

test("disabled removes a skill by name", async () => {
  await writeSkill(".zcode/skills", "delta", "---\ndescription: delta\n---\nD")
  const { skills } = await discoverSkills(project, config({ disabled: ["delta"] }))
  expect(skills.some((skill) => skill.name === "delta")).toBe(false)
})

test("malformed frontmatter is skipped with a warning, not fatal", async () => {
  await writeSkill(".zcode/skills", "good", "---\ndescription: good\n---\nOK")
  await writeSkill(".zcode/skills", "bad", "---\ndescription: [1, 2]\n---\nnope")
  const { skills, warnings } = await discoverSkills(project, config())
  expect(skills.some((skill) => skill.name === "good")).toBe(true)
  expect(skills.some((skill) => skill.name === "bad")).toBe(false)
  expect(warnings.some((warning) => warning.includes("bad"))).toBe(true)
})

test("bundled create-skill is present by default, overridable, and removable", async () => {
  const withBundled = await discoverSkills(project, config({ bundled: true }))
  const bundled = withBundled.skills.find((skill) => skill.name === "create-skill")
  expect(bundled?.source).toBe("bundled")

  await writeSkill(".zcode/skills", "create-skill", "---\ndescription: mine\n---\nMINE")
  const overridden = await discoverSkills(project, config({ bundled: true }))
  const disk = overridden.skills.find((skill) => skill.name === "create-skill")
  expect(disk?.source).toBe("disk")
  expect(disk?.body).toBe("MINE")

  const off = await discoverSkills(project, config({ bundled: false, disabled: [] }))
  await rm(path.join(project, ".zcode/skills/create-skill"), { recursive: true, force: true })
  const offClean = await discoverSkills(project, config({ bundled: false }))
  expect(off.skills.some((skill) => skill.name === "create-skill")).toBe(true) // disk copy still there
  expect(offClean.skills.some((skill) => skill.name === "create-skill")).toBe(false)
})

test("realpath dedupe drops a symlinked duplicate", async () => {
  await writeSkill(".zcode/skills", "orig", "---\ndescription: orig\n---\nO")
  await mkdir(path.join(project, ".claude/skills"), { recursive: true })
  await symlink(path.join(project, ".zcode/skills/orig"), path.join(project, ".claude/skills/link"), "dir")
  const { skills } = await discoverSkills(project, config())
  expect(skills.some((skill) => skill.name === "orig")).toBe(true)
  expect(skills.some((skill) => skill.name === "link")).toBe(false)
})
