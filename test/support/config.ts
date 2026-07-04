import { ConfigSchema, type ResolvedConfig } from "@/config/config"

export function testConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  const base = ConfigSchema.parse({})
  return { ...base, cwd: "/tmp/zcode-test", ...overrides }
}

export function withApiKey(): () => void {
  const prev = process.env["ZAI_API_KEY"]
  process.env["ZAI_API_KEY"] = "test-key"
  return () => {
    if (prev === undefined) delete process.env["ZAI_API_KEY"]
    else process.env["ZAI_API_KEY"] = prev
  }
}
