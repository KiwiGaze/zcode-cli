let cachedPath: string | null | undefined

export async function ripgrepPath(): Promise<string | null> {
  if (cachedPath !== undefined) return cachedPath
  const found = Bun.which("rg")
  cachedPath = found ?? null
  return cachedPath
}

export interface GrepMatch {
  path: string
  line: number
  text: string
}

export async function runRipgrep(args: string[], cwd: string, signal: AbortSignal): Promise<string> {
  const bin = await ripgrepPath()
  if (bin === null) throw new Error("ripgrep (rg) is not installed or not on PATH")
  const proc = Bun.spawn([bin, ...args], { cwd, stdout: "pipe", stderr: "pipe", signal })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const exit = await proc.exited
  // rg exit code 1 == no matches (not an error); >1 == real failure
  if (exit > 1) throw new Error(stderr.trim() || `ripgrep exited with code ${exit}`)
  return stdout
}
