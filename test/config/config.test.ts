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

test("modelInfo returns known model metadata", () => {
  const config = testConfig()
  expect(modelInfo(config, "glm-5.2")?.context).toBe(200_000)
  expect(modelInfo(config, "does-not-exist")).toBeUndefined()
})
