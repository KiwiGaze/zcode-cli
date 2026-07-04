import path from "node:path"
import { stat } from "node:fs/promises"
import { globalConfigDir } from "@/config/paths"

export interface InstructionFile {
  path: string
  content: string
}

const PROJECT_FILES = ["AGENTS.md", "CLAUDE.md"]

async function isDir(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory()
  } catch {
    return false
  }
}

async function findGitRoot(cwd: string): Promise<string> {
  let dir = path.resolve(cwd)
  while (true) {
    if (await isDir(path.join(dir, ".git"))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return path.resolve(cwd)
    dir = parent
  }
}

/**
 * Directories from the git root down to cwd, so nearer (more specific)
 * instruction files are read last.
 */
async function directoryChain(cwd: string): Promise<string[]> {
  const root = await findGitRoot(cwd)
  const chain: string[] = []
  let dir = path.resolve(cwd)
  while (true) {
    chain.push(dir)
    if (dir === root) break
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return chain.reverse()
}

export async function discoverInstructions(cwd: string): Promise<InstructionFile[]> {
  const files: InstructionFile[] = []
  const seen = new Set<string>()

  await tryAdd(path.join(globalConfigDir(), "AGENTS.md"), files, seen)

  for (const dir of await directoryChain(cwd)) {
    for (const name of PROJECT_FILES) await tryAdd(path.join(dir, name), files, seen)
  }
  return files
}

async function tryAdd(candidate: string, files: InstructionFile[], seen: Set<string>): Promise<void> {
  const resolved = path.resolve(candidate)
  if (seen.has(resolved)) return
  seen.add(resolved)
  const file = Bun.file(resolved)
  if (!(await file.exists())) return
  const content = (await file.text()).trim()
  if (content.length === 0) return
  files.push({ path: resolved, content })
}
