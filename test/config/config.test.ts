import { test, expect } from "bun:test"
import { ConfigSchema, applyEnvironmentOverrides, deepMerge, modelInfo } from "@/config/config"
import { testConfig } from "../support/config"

test("config schema fills defaults", () => {
  const config = ConfigSchema.parse({})
  expect(config.provider).toBe("zai")
  expect(config.model).toBe("glm-5.2")
  expect(config.endpointKind).toBe("coding")
  expect(config.compaction.threshold).toBe(0.8)
  expect(config.ui).toEqual({
    theme: "dark",
    animations: true,
    attention: "blurred",
    terminalProgress: false,
  })
})

test("ui config accepts each explicit presentation mode", () => {
  expect(
    ConfigSchema.parse({
      ui: { theme: "auto", animations: false, attention: "always", terminalProgress: true },
    }).ui,
  ).toEqual({
    theme: "auto",
    animations: false,
    attention: "always",
    terminalProgress: true,
  })

  expect(ConfigSchema.safeParse({ ui: { theme: "system" } }).success).toBe(false)
  expect(ConfigSchema.safeParse({ ui: { animations: "no" } }).success).toBe(false)
  expect(ConfigSchema.safeParse({ ui: { attention: "focused" } }).success).toBe(false)
})

test("ZCODE_NO_ANIM=1 explicitly disables only animations", () => {
  const config = ConfigSchema.parse({
    ui: { theme: "light", animations: true, attention: "always", terminalProgress: true },
  })

  expect(applyEnvironmentOverrides(config, { ZCODE_NO_ANIM: "1" }).ui).toEqual({
    theme: "light",
    animations: false,
    attention: "always",
    terminalProgress: true,
  })
  expect(applyEnvironmentOverrides(config, { ZCODE_NO_ANIM: "true" })).toBe(config)
  expect(applyEnvironmentOverrides(config, {})).toBe(config)
})

test("deepMerge overrides project over global without dropping nested keys", () => {
  const merged = deepMerge(
    { permissions: { bash: "ask", edit: "ask" }, model: "glm-5.2" },
    { permissions: { bash: "deny" }, provider: "bigmodel" },
  )
  expect(merged).toEqual({
    permissions: { bash: "deny", edit: "ask" },
    model: "glm-5.2",
    provider: "bigmodel",
  })
})

test("parses autoMode defaults and rejects bad limits", () => {
  const config = ConfigSchema.parse({})
  expect(config.autoMode).toEqual({ enabled: false, maxConsecutiveDenials: 3, maxTotalDenials: 20 })

  expect(ConfigSchema.safeParse({ autoMode: { maxConsecutiveDenials: 0 } }).success).toBe(false)
  expect(ConfigSchema.safeParse({ autoMode: { maxTotalDenials: -1 } }).success).toBe(false)

  const partial = ConfigSchema.parse({ autoMode: { enabled: true, gateModel: "glm-4.7" } })
  expect(partial.autoMode).toEqual({
    enabled: true,
    gateModel: "glm-4.7",
    maxConsecutiveDenials: 3,
    maxTotalDenials: 20,
  })
})

test("agents config defaults to interop on with no extra paths", () => {
  const config = ConfigSchema.parse({})
  expect(config.agents).toEqual({ paths: [], disabled: [], interop: { claude: true } })

  const partial = ConfigSchema.parse({ agents: { disabled: ["plan"] } })
  expect(partial.agents).toEqual({ paths: [], disabled: ["plan"], interop: { claude: true } })

  expect(ConfigSchema.safeParse({ agents: { paths: "not-a-list" } }).success).toBe(false)
  expect(ConfigSchema.safeParse({ agents: { interop: { claude: "yes" } } }).success).toBe(false)
})

test("defaults early tool execution on and accepts the opt-out", () => {
  expect(ConfigSchema.parse({}).earlyToolExecution).toBe(true)
  expect(ConfigSchema.parse({ earlyToolExecution: false }).earlyToolExecution).toBe(false)
  expect(ConfigSchema.safeParse({ earlyToolExecution: "yes" }).success).toBe(false)
})

test("autonomy defaults to 25/100 and rejects non-positive caps", () => {
  const config = ConfigSchema.parse({})
  expect(config.autonomy).toEqual({ goalMaxEvaluations: 25, loopMaxTicks: 100 })

  expect(ConfigSchema.safeParse({ autonomy: { goalMaxEvaluations: 0 } }).success).toBe(false)
  expect(ConfigSchema.safeParse({ autonomy: { loopMaxTicks: -1 } }).success).toBe(false)
  expect(ConfigSchema.safeParse({ autonomy: { loopMaxTicks: 2.5 } }).success).toBe(false)

  const partial = ConfigSchema.parse({ autonomy: { loopMaxTicks: 10 } })
  expect(partial.autonomy).toEqual({ goalMaxEvaluations: 25, loopMaxTicks: 10 })
})

test("config defaults mcp server defer to false and accepts true", () => {
  const plain = ConfigSchema.parse({ mcp: { servers: { srv: { type: "stdio", command: "bun" } } } })
  expect(plain.mcp.servers["srv"]?.defer).toBe(false)

  const deferred = ConfigSchema.parse({
    mcp: { servers: { srv: { type: "stdio", command: "bun", defer: true } } },
  })
  expect(deferred.mcp.servers["srv"]?.defer).toBe(true)

  const http = ConfigSchema.parse({
    mcp: { servers: { web: { type: "http", url: "https://example.invalid/mcp", defer: true } } },
  })
  expect(http.mcp.servers["web"]?.defer).toBe(true)

  expect(
    ConfigSchema.safeParse({ mcp: { servers: { srv: { type: "stdio", command: "bun", defer: "yes" } } } }).success,
  ).toBe(false)
})

test("rejects invalid budget values and defaults to unlimited", () => {
  const config = ConfigSchema.parse({})
  expect(config.budget).toEqual({ warnAt: 0.8 })

  expect(ConfigSchema.safeParse({ budget: { maxTurns: 0 } }).success).toBe(false)
  expect(ConfigSchema.safeParse({ budget: { maxTurns: 1.5 } }).success).toBe(false)
  expect(ConfigSchema.safeParse({ budget: { maxCostUsd: -1 } }).success).toBe(false)
  expect(ConfigSchema.safeParse({ budget: { warnAt: 1.2 } }).success).toBe(false)

  const partial = ConfigSchema.parse({ budget: { maxTurns: 3 } })
  expect(partial.budget).toEqual({ maxTurns: 3, warnAt: 0.8 })
})

test("memory config defaults to enabled with a 60 KB budget", () => {
  const config = ConfigSchema.parse({})
  expect(config.memory).toEqual({ enabled: true, sessionBudgetBytes: 61_440 })

  const partial = ConfigSchema.parse({ memory: { enabled: false } })
  expect(partial.memory).toEqual({ enabled: false, sessionBudgetBytes: 61_440 })

  expect(ConfigSchema.safeParse({ memory: { sessionBudgetBytes: 0 } }).success).toBe(false)
  expect(ConfigSchema.safeParse({ memory: { sessionBudgetBytes: -1 } }).success).toBe(false)
})

test("modelInfo returns known model metadata", () => {
  const config = testConfig()
  expect(modelInfo(config, "glm-5.2")?.context).toBe(200_000)
  expect(modelInfo(config, "does-not-exist")).toBeUndefined()
})
