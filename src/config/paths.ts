import os from "node:os"
import path from "node:path"
import { stat } from "node:fs/promises"

export const APP_ID = "zcode"

export function globalConfigDir(): string {
  const xdg = process.env["XDG_CONFIG_HOME"]
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".config")
  return path.join(base, APP_ID)
}

export function globalConfigFile(): string {
  return path.join(globalConfigDir(), "config.json")
}

export function projectConfigFile(cwd: string): string {
  return path.join(cwd, ".zcode.json")
}

export function dataDir(): string {
  const xdg = process.env["XDG_DATA_HOME"]
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".local", "share")
  return path.join(base, APP_ID)
}

export function cwdSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-")
}

export function sessionDir(cwd: string): string {
  return path.join(dataDir(), "projects", cwdSlug(cwd))
}

export function memoryDir(cwd: string): string {
  return path.join(sessionDir(cwd), "memory")
}

/** Directories from cwd up to the repository root, nearest first, so nearer definitions win. */
export async function projectChain(cwd: string): Promise<string[]> {
  const root = await repoRoot(cwd)
  const chain: string[] = []
  let dir = path.resolve(cwd)
  while (true) {
    chain.push(dir)
    if (dir === root) break
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return chain
}

export interface DiscoveryRoots {
  /** Directory name under each config root, e.g. `"skills"` or `"agents"`. */
  kind: string
  /** Which foreign config directories to also read definitions from. */
  interop: { claude: boolean; agents?: boolean }
  /** Extra roots from config, appended last and lowest-precedence. */
  extraPaths: readonly string[]
}

/**
 * Every directory to scan for definitions of one `kind`, in precedence order: nearest project
 * directory first, native `.zcode` ahead of interop, project ahead of global, configured extras
 * last. Callers take the first definition to claim a name, so this order *is* the override rule.
 */
export async function discoveryRoots(cwd: string, options: DiscoveryRoots): Promise<string[]> {
  const { kind, interop } = options
  const roots: string[] = []
  for (const dir of await projectChain(cwd)) {
    roots.push(path.join(dir, ".zcode", kind))
    if (interop.claude) roots.push(path.join(dir, ".claude", kind))
    if (interop.agents === true) roots.push(path.join(dir, ".agents", kind))
  }
  const home = os.homedir()
  roots.push(path.join(globalConfigDir(), kind))
  if (interop.claude) roots.push(path.join(home, ".claude", kind))
  if (interop.agents === true) roots.push(path.join(home, ".agents", kind))
  for (const extra of options.extraPaths) roots.push(expandPath(extra, cwd))
  return roots
}

/** Resolve a configured path, expanding a leading `~/`, against `cwd`. */
export function expandPath(target: string, cwd: string): string {
  const expanded = target.startsWith("~/") ? path.join(os.homedir(), target.slice(2)) : target
  return path.resolve(cwd, expanded)
}

/** Nearest ancestor holding `.git`. A linked worktree or submodule marks its root with a *file*. */
async function repoRoot(cwd: string): Promise<string> {
  let dir = path.resolve(cwd)
  while (true) {
    if (await exists(path.join(dir, ".git"))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return path.resolve(cwd)
    dir = parent
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}
