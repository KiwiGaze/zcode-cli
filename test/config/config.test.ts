import { test, expect } from "bun:test"
import { ConfigSchema, deepMerge, modelInfo } from "@/config/config"
import { testConfig } from "../support/config"

test("config schema fills defaults", () => {
  const config = ConfigSchema.parse({})
  expect(config.provider).toBe("zai")
  expect(config.model).toBe("glm-5.2")
  expect(config.endpointKind).toBe("coding")
  expect(config.compaction.threshold).toBe(0.8)
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
  expect(config.budget.maxTurns).toBeUndefined()
  expect(config.budget.maxCostUsd).toBeUndefined()

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
