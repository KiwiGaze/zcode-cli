import os from "node:os"
import path from "node:path"

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
