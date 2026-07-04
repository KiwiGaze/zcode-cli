#!/usr/bin/env bun
import { Glob } from "bun"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "..")
const SRC = path.join(ROOT, "src")
const LLM_DIR = path.join(SRC, "llm")

const FORBIDDEN = [/from\s+["']ai["']/, /from\s+["']@ai-sdk\//]

async function main(): Promise<void> {
  const violations: string[] = []
  const glob = new Glob("**/*.{ts,tsx}")
  for await (const rel of glob.scan({ cwd: SRC })) {
    const abs = path.join(SRC, rel)
    if (abs.startsWith(LLM_DIR + path.sep)) continue
    const text = await Bun.file(abs).text()
    for (const pattern of FORBIDDEN) {
      if (pattern.test(text)) {
        violations.push(`${path.join("src", rel)} imports the AI SDK (${pattern.source})`)
      }
    }
  }
  if (violations.length > 0) {
    process.stderr.write("AI SDK import boundary violated:\n")
    for (const violation of violations) process.stderr.write(`  - ${violation}\n`)
    process.stderr.write("The AI SDK must stay inside src/llm/.\n")
    process.exit(1)
  }
  process.stdout.write("llm boundary ok\n")
}

await main()
